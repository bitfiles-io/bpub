/**
 * Signing the transactions BPUB needs: revealing an inscription, transferring
 * v5 ownership, and (optionally) funding the inscription outputs.
 *
 * This is the one part of the library that leans on `@scure/btc-signer`
 * instead of hand-rolled primitives. Everything above (encode/decode, script
 * and transaction parsing, address handling) stays dependency-free; actually
 * producing valid ECDSA signatures is exactly the kind of code that should
 * come from an audited library rather than be reimplemented here.
 *
 * The BPUB multisig redeem script is a standard 1-of-N bare multisig, so the
 * reveal path uses `@scure/btc-signer`'s `Transaction` end to end (`sign` +
 * `finalize`). The v5 ownership redeem script is a nonstandard shape (a
 * P2WPKH check wrapped with an extra `OP_DROP`), which the library's
 * high-level script recognition doesn't know about, so that path uses its
 * lower-level pieces instead: `preimageWitnessV0` for the BIP-143 sighash and
 * `signECDSA` for the signature, with the witness assembled by hand.
 */

import { Transaction as ScureTransaction, SigHash } from "@scure/btc-signer";
import { pubECDSA, signECDSA } from "@scure/btc-signer/utils.js";

import { bytesToHex, concatBytes, reverseBytes } from "./bytes.ts";
import { DUST } from "./constants.ts";
import { estimateFeeOwnerTransfer, estimateFeeReveal } from "./fees.ts";
import { hash160 } from "./hash.ts";
import { buildOwnerRedeemScript, p2wpkhScriptPubKey, p2wshScriptPubKey } from "./script.ts";
import { addressToScriptPubKey, ownerH160FromAddress } from "./bech32.ts";
import { deserializeTransaction, transactionId, txidToBytes } from "./tx.ts";
import type { Transaction } from "./tx.ts";
import type { FundingTransaction, Utxo } from "./txbuild.ts";

/** scure's input `txid` is display order; bpub's txid bytes are internal order, so reverse on the way in. */
const scureTxid = (internalTxid: Uint8Array): Uint8Array => reverseBytes(internalTxid);

/** The result of any of the signing helpers below. */
export interface SignedTransaction {
  transaction: Transaction;
  rawHex: string;
  txid: string;
  feeSats: number;
}

export interface RevealInput {
  /** The BPUB multisig P2WSH output being spent (from a funding transaction). */
  txid: string;
  vout: number;
  valueSats: number;
  /** The exact redeem script the output committed to, e.g. `Inscription.redeemScripts[i]`. */
  redeemScript: Uint8Array;
}

export interface SignRevealTransactionOptions {
  inputs: RevealInput[];
  /** Where the combined value (minus fee) is sent once the data is revealed. */
  destinationAddress: string;
  /** 32-byte private key matching the control pubkey baked into every redeem script. */
  controlPrivateKey: Uint8Array;
  feerate: number;
  hrp?: string;
  sequence?: number;
  lockTime?: number;
  version?: number;
}

/**
 * Build and sign a reveal transaction: spends every BPUB multisig output with
 * the control private key, putting each redeem script into the witness so the
 * data becomes readable on-chain. This is the funding transaction's
 * counterpart; call {@link recoverFromRawTransaction} on the result to read
 * the data back.
 */
export async function signRevealTransaction(
  options: SignRevealTransactionOptions,
): Promise<SignedTransaction> {
  const {
    inputs,
    destinationAddress,
    controlPrivateKey,
    feerate,
    hrp = "bc",
    sequence = 0xffffffff,
    lockTime = 0,
    version = 2,
  } = options;

  if (inputs.length === 0) throw new Error("signRevealTransaction requires at least one input");
  if (controlPrivateKey.length !== 32) throw new Error("controlPrivateKey must be 32 bytes");

  const totalInputSats = inputs.reduce((sum, input) => sum + input.valueSats, 0);
  const feeSats = estimateFeeReveal(inputs.length, 1, feerate);
  const valueSats = totalInputSats - feeSats;
  if (valueSats <= DUST) {
    throw new Error(`reveal output would be dust or negative after fees: ${valueSats} sats`);
  }

  const scureTx = new ScureTransaction({ version, lockTime, allowLegacyWitnessUtxo: true });
  for (const input of inputs) {
    const scriptPubKey = await p2wshScriptPubKey(input.redeemScript);
    scureTx.addInput({
      txid: scureTxid(txidToBytes(input.txid)),
      index: input.vout,
      witnessUtxo: { amount: BigInt(input.valueSats), script: scriptPubKey },
      witnessScript: input.redeemScript,
      sequence,
      sighashType: SigHash.ALL,
    });
  }
  scureTx.addOutput({
    script: addressToScriptPubKey(destinationAddress, hrp),
    amount: BigInt(valueSats),
  });

  let signedCount: number;
  try {
    signedCount = scureTx.sign(controlPrivateKey, [SigHash.ALL]);
  } catch {
    signedCount = 0;
  }
  if (signedCount !== inputs.length) {
    throw new Error(
      `controlPrivateKey only matched ${signedCount} of ${inputs.length} redeem scripts`,
    );
  }
  scureTx.finalize();

  const rawBytes = scureTx.extract();
  const transaction = deserializeTransaction(rawBytes);
  return { transaction, rawHex: bytesToHex(rawBytes), txid: await transactionId(transaction), feeSats };
}

export interface SignOwnerTransferTransactionOptions {
  /** The BPUB v5 stream id (`Inscription.bpubId`) the ownership output commits to. */
  bpubId: Uint8Array;
  /** 32-byte private key of the current owner. */
  ownerPrivateKey: Uint8Array;
  /** The current ownership UTXO. */
  utxo: Utxo;
  /** P2WPKH (`bc1q...`) address of the new owner. */
  newOwnerAddress: string;
  feerate: number;
  hrp?: string;
  sequence?: number;
  lockTime?: number;
  version?: number;
}

/**
 * Build and sign a v5 ownership-transfer transaction: spends the current
 * ownership UTXO with the current owner's private key and recreates the
 * ownership output for the new owner. The redeem script is nonstandard, so
 * this signs it directly rather than going through `Transaction.finalize()`.
 */
export async function signOwnerTransferTransaction(
  options: SignOwnerTransferTransactionOptions,
): Promise<SignedTransaction> {
  const {
    bpubId,
    ownerPrivateKey,
    utxo,
    newOwnerAddress,
    feerate,
    hrp = "bc",
    sequence = 0xffffffff,
    lockTime = 0,
    version = 2,
  } = options;

  if (bpubId.length !== 32) throw new Error("bpubId must be 32 bytes");
  if (ownerPrivateKey.length !== 32) throw new Error("ownerPrivateKey must be 32 bytes");

  const ownerPubkey = pubECDSA(ownerPrivateKey, true);
  const ownerH160 = await hash160(ownerPubkey);
  const redeemScript = buildOwnerRedeemScript(bpubId, ownerH160);
  const scriptPubKey = await p2wshScriptPubKey(redeemScript);

  const newOwnerH160 = ownerH160FromAddress(newOwnerAddress, hrp);
  const newScriptPubKey = await p2wshScriptPubKey(buildOwnerRedeemScript(bpubId, newOwnerH160));

  const feeSats = estimateFeeOwnerTransfer(1, 1, feerate);
  const valueSats = utxo.valueSats - feeSats;
  if (valueSats <= DUST) {
    throw new Error(`owner-transfer output would be dust or negative after fees: ${valueSats} sats`);
  }

  const scureTx = new ScureTransaction({
    version,
    lockTime,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  scureTx.addInput({
    txid: scureTxid(txidToBytes(utxo.txid)),
    index: utxo.vout,
    witnessUtxo: { amount: BigInt(utxo.valueSats), script: scriptPubKey },
    sequence,
  });
  scureTx.addOutput({ script: newScriptPubKey, amount: BigInt(valueSats) });

  const hashType = SigHash.ALL;
  const sighash = scureTx.preimageWitnessV0(0, redeemScript, hashType, BigInt(utxo.valueSats));
  const signature = concatBytes(signECDSA(sighash, ownerPrivateKey, true), new Uint8Array([hashType]));
  scureTx.updateInput(0, { finalScriptWitness: [signature, ownerPubkey, redeemScript] });

  const rawBytes = scureTx.extract();
  const transaction = deserializeTransaction(rawBytes);
  return { transaction, rawHex: bytesToHex(rawBytes), txid: await transactionId(transaction), feeSats };
}

export interface SignFundingTransactionOptions {
  /** The unsigned funding transaction from {@link buildFundingTransaction}. */
  funding: FundingTransaction;
  /** The UTXO being spent (the same one passed to `buildFundingTransaction`). */
  utxo: Utxo;
  /** 32-byte private key controlling the UTXO. Must be a P2WPKH key. */
  privateKey: Uint8Array;
}

/**
 * Sign a funding transaction's single P2WPKH input. `buildFundingTransaction`
 * deliberately returns an unsigned transaction; this covers the common case
 * of a plain wallet UTXO funding the inscription.
 */
export async function signFundingTransaction(
  options: SignFundingTransactionOptions,
): Promise<SignedTransaction> {
  const { funding, utxo, privateKey } = options;
  const { transaction } = funding;
  const input = transaction.inputs[0];
  if (!input || transaction.inputs.length !== 1) {
    throw new Error("signFundingTransaction expects a single-input funding transaction");
  }
  if (privateKey.length !== 32) throw new Error("privateKey must be 32 bytes");

  const spendScriptPubKey = p2wpkhScriptPubKey(await hash160(pubECDSA(privateKey, true)));

  const scureTx = new ScureTransaction({ version: transaction.version, lockTime: transaction.lockTime });
  scureTx.addInput({
    txid: scureTxid(input.prevTxid),
    index: input.prevIndex,
    witnessUtxo: { amount: BigInt(utxo.valueSats), script: spendScriptPubKey },
    sequence: input.sequence,
  });
  for (const output of transaction.outputs) {
    scureTx.addOutput({ script: output.scriptPubKey, amount: BigInt(output.value) });
  }

  try {
    scureTx.sign(privateKey);
  } catch {
    throw new Error("privateKey does not match the funding UTXO's P2WPKH pubkey hash");
  }
  scureTx.finalize();

  const rawBytes = scureTx.extract();
  const signed = deserializeTransaction(rawBytes);
  return {
    transaction: signed,
    rawHex: bytesToHex(rawBytes),
    txid: await transactionId(signed),
    feeSats: funding.feeSats,
  };
}
