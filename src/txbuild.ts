/**
 * Building the encode side: turn a file into BPUB redeem scripts / P2WSH
 * outputs, and assemble an unsigned funding transaction.
 *
 * Signing, PSBTs and node RPC are intentionally out of scope: they belong to
 * the upstream CLI, not to a library that also runs in a browser.
 */

import { DUST } from "./constants.ts";
import { addressToScriptPubKey, ownerH160FromAddress } from "./bech32.ts";
import { estimateFee } from "./fees.ts";
import { chunkDataPubkeys, encodeStreamToPubkeys } from "./pubkeys.ts";
import {
  buildMultisigScript,
  buildOwnerRedeemScript,
  p2wshScriptPubKey,
} from "./script.ts";
import { buildStreamV35, buildStreamV4, buildStreamV5, computeBpubV5Id } from "./stream.ts";
import { serializeTransaction, txidToBytes } from "./tx.ts";
import type { Transaction, TxOutput } from "./tx.ts";
import { bytesToHex } from "./bytes.ts";

export type BpubVersion = "v3.5" | "v4" | "v5";

export interface InscriptionOptions {
  /** Stream version to emit. Defaults to `"v5"`. */
  version?: BpubVersion;
  mime?: string;
  filename?: string;
  compress?: boolean;
  /** 33-byte compressed pubkey whose private key you control. */
  controlPubkey: Uint8Array;
}

export interface Inscription {
  version: BpubVersion;
  /** The full BPUB stream that was encoded into pubkeys. */
  stream: Uint8Array;
  dataPubkeys: Uint8Array[];
  /** One redeem script per data output (up to 14 data pubkeys each). */
  redeemScripts: Uint8Array[];
  /** P2WSH scriptPubKeys committing to `redeemScripts`. */
  scriptPubKeys: Uint8Array[];
  /** v5 only. */
  bpubId?: Uint8Array;
}

/** Encode a file into BPUB redeem scripts and their P2WSH scriptPubKeys. */
export async function buildInscription(
  data: Uint8Array,
  options: InscriptionOptions,
): Promise<Inscription> {
  const { version = "v5", mime = "", filename = "", compress = false, controlPubkey } = options;
  if (controlPubkey.length !== 33) {
    throw new Error("controlPubkey must be a 33-byte compressed pubkey");
  }

  const streamOptions = { mime, filename, compress };
  let stream: Uint8Array;
  let bpubId: Uint8Array | undefined;
  if (version === "v3.5") {
    stream = await buildStreamV35(data, streamOptions);
  } else if (version === "v4") {
    stream = await buildStreamV4(data, streamOptions);
  } else {
    stream = await buildStreamV5(data, streamOptions);
    bpubId = await computeBpubV5Id(data);
  }

  const dataPubkeys = encodeStreamToPubkeys(stream);
  const redeemScripts: Uint8Array[] = [];
  const scriptPubKeys: Uint8Array[] = [];
  for (const chunk of chunkDataPubkeys(dataPubkeys)) {
    const redeemScript = buildMultisigScript(chunk, controlPubkey);
    redeemScripts.push(redeemScript);
    scriptPubKeys.push(await p2wshScriptPubKey(redeemScript));
  }

  const inscription: Inscription = {
    version,
    stream,
    dataPubkeys,
    redeemScripts,
    scriptPubKeys,
  };
  if (bpubId) inscription.bpubId = bpubId;
  return inscription;
}

export interface Utxo {
  txid: string;
  vout: number;
  valueSats: number;
}

export interface FundingTransactionOptions extends InscriptionOptions {
  /** File bytes to inscribe. */
  data: Uint8Array;
  /** The single UTXO being spent. */
  utxo: Utxo;
  feerate: number;
  /** Change address (`bc1...`). Required for v5, which adds an owner output. */
  changeAddress?: string;
  /** Owner P2WPKH address (`bc1q...`). Required for v5. */
  ownerAddress?: string;
  /** Value of the ownership output. Defaults to 10000 sats, as upstream. */
  ownerValueSats?: number;
  hrp?: string;
}

export interface FundingTransaction {
  inscription: Inscription;
  transaction: Transaction;
  rawHex: string;
  feeSats: number;
  changeSats: number;
  ownerValueSats: number;
}

/**
 * Build an unsigned funding transaction that commits to the file through P2WSH
 * 1-of-N multisig outputs, plus (for v5) the mandatory ownership output.
 */
export async function buildFundingTransaction(
  options: FundingTransactionOptions,
): Promise<FundingTransaction> {
  const {
    utxo,
    feerate,
    changeAddress,
    ownerAddress,
    ownerValueSats: requestedOwnerValue = 10000,
    hrp = "bc",
    version = "v5",
  } = options;

  if (version !== "v5" && ownerAddress) {
    throw new Error("ownership is only supported by v5; v3.5 and v4 have no owner output");
  }
  if (version === "v5" && !ownerAddress) {
    throw new Error("BPUB v5 requires an ownerAddress (P2WPKH) to set ownership");
  }

  const inscription = await buildInscription(options.data, options);

  let outputCount = inscription.scriptPubKeys.length;
  let ownerScriptPubKey: Uint8Array | null = null;
  if (version === "v5") {
    const ownerH160 = ownerH160FromAddress(ownerAddress!, hrp);
    ownerScriptPubKey = await p2wshScriptPubKey(
      buildOwnerRedeemScript(inscription.bpubId!, ownerH160),
    );
    outputCount += 1;
  }

  const includeChange = Boolean(changeAddress);
  if (includeChange) outputCount += 1;

  const feeSats = estimateFee(1, outputCount, feerate);
  if (utxo.valueSats <= feeSats) {
    throw new Error(`UTXO too small for the fee: need > ${feeSats} sats`);
  }

  if (ownerScriptPubKey && !includeChange) {
    throw new Error(
      "a v5 ownership output requires a changeAddress; per-output values are not guessed",
    );
  }

  let values: number[];
  let changeSats = 0;
  let ownerValueSats = 0;

  if (!includeChange) {
    const perOutput = Math.floor(utxo.valueSats / inscription.scriptPubKeys.length);
    if (perOutput <= DUST) {
      throw new Error("per-output value would be dust without change; pass a changeAddress");
    }
    values = new Array(inscription.scriptPubKeys.length).fill(perOutput);
  } else {
    const bpubTotal = inscription.scriptPubKeys.length * DUST;
    ownerValueSats = ownerScriptPubKey ? requestedOwnerValue : 0;
    const available = utxo.valueSats - feeSats;
    if (available <= bpubTotal + ownerValueSats) {
      throw new Error(
        `not enough for BPUB outputs + owner + change: need > ${bpubTotal + ownerValueSats} sats`,
      );
    }
    values = new Array(inscription.scriptPubKeys.length).fill(DUST);
    changeSats = utxo.valueSats - feeSats - bpubTotal - ownerValueSats;
    if (changeSats < DUST) {
      throw new Error(`change (${changeSats} sats) would be dust; increase the UTXO or fee rate`);
    }
  }

  const outputs: TxOutput[] = inscription.scriptPubKeys.map((scriptPubKey, i) => ({
    value: values[i]!,
    scriptPubKey,
  }));
  if (ownerScriptPubKey && ownerValueSats > 0) {
    outputs.push({ value: ownerValueSats, scriptPubKey: ownerScriptPubKey });
  }
  if (includeChange) {
    outputs.push({
      value: changeSats,
      scriptPubKey: addressToScriptPubKey(changeAddress!, hrp),
    });
  }

  const transaction: Transaction = {
    version: 2,
    inputs: [
      {
        prevTxid: txidToBytes(utxo.txid),
        prevIndex: utxo.vout,
        scriptSig: new Uint8Array(0),
        sequence: 0xffffffff,
        witness: [],
      },
    ],
    outputs,
    lockTime: 0,
    hasWitness: false,
  };

  return {
    inscription,
    transaction,
    rawHex: bytesToHex(serializeTransaction(transaction)),
    feeSats,
    changeSats,
    ownerValueSats,
  };
}
