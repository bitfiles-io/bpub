/**
 * Recovering BPUB data from on-chain transactions: the library equivalents of
 * the upstream `txrecover` and `decodetransfer` commands.
 */

import { bytesEqual, bytesToHex, hexToBytes } from "./bytes.ts";
import { decodePubkeysToStream } from "./pubkeys.ts";
import {
  decodeOwnerRedeemScript,
  p2wshScriptPubKey,
  parseBpubMultisigScript,
} from "./script.ts";
import { addressFromOwnerH160 } from "./bech32.ts";
import { decodeStream } from "./stream.ts";
import type { BpubMeta } from "./stream.ts";
import { deserializeTransaction } from "./tx.ts";
import type { Transaction } from "./tx.ts";

export interface RecoverOptions {
  /**
   * The 33-byte control pubkey (bytes or hex) that terminates each BPUB
   * multisig script. Defaults to `"auto"`, which detects it from the
   * transaction and fails if the inputs disagree.
   */
  controlPubkey?: Uint8Array | string;
}

export interface RecoveredInput {
  /** Index of the transaction input the script came from. */
  index: number;
  dataPubkeys: Uint8Array[];
}

export interface RecoverResult {
  meta: BpubMeta;
  /** The reassembled file bytes. */
  content: Uint8Array;
  /** Control pubkey used (supplied, or auto-detected). */
  controlPubkey: Uint8Array;
  /** The raw BPUB stream before header parsing, including chunk padding. */
  stream: Uint8Array;
  inputs: RecoveredInput[];
}

function normalizeControlPubkey(value: Uint8Array | string | undefined): Uint8Array | null {
  if (value === undefined) return null;
  if (typeof value === "string") {
    if (value.toLowerCase() === "auto") return null;
    const bytes = hexToBytes(value);
    if (bytes.length !== 33) throw new Error("controlPubkey must be a 33-byte compressed pubkey");
    return bytes;
  }
  if (value.length !== 33) throw new Error("controlPubkey must be a 33-byte compressed pubkey");
  return value;
}

/**
 * Recover BPUB data from a *reveal* transaction: one that spends the 1-of-N
 * multisig P2WSH outputs created by the funding transaction.
 *
 * For every input whose witness ends in a BPUB multisig script (and whose
 * control pubkey matches), the leading pubkeys are collected in order,
 * concatenated, and decoded as a BPUB stream. Signatures are ignored, since
 * their layout is wallet-specific.
 */
export async function recoverFromTransaction(
  tx: Transaction,
  options: RecoverOptions = {},
): Promise<RecoverResult> {
  const expectedControl = normalizeControlPubkey(options.controlPubkey);
  const autoDetect = expectedControl === null;

  if (!tx.hasWitness || tx.inputs.every((input) => input.witness.length === 0)) {
    throw new Error("transaction has no witness data");
  }

  const inputs: RecoveredInput[] = [];
  const allDataPubkeys: Uint8Array[] = [];
  const detectedControls: Uint8Array[] = [];

  for (const [index, input] of tx.inputs.entries()) {
    if (input.witness.length < 2) continue;

    const redeemScript = input.witness[input.witness.length - 1]!;
    const parsed = parseBpubMultisigScript(redeemScript);
    if (!parsed) continue;

    if (expectedControl) {
      if (!bytesEqual(parsed.controlPubkey, expectedControl)) continue;
    } else {
      detectedControls.push(parsed.controlPubkey);
    }

    inputs.push({ index, dataPubkeys: parsed.dataPubkeys });
    allDataPubkeys.push(...parsed.dataPubkeys);
  }

  let controlPubkey: Uint8Array;
  if (autoDetect) {
    if (detectedControls.length === 0) {
      throw new Error("no BPUB-like multisig scripts found (auto-detect failed)");
    }
    const unique = new Map<string, Uint8Array>();
    for (const pk of detectedControls) unique.set(bytesToHex(pk), pk);
    if (unique.size > 1) {
      throw new Error(
        `auto-detect found multiple distinct control pubkeys: ${[...unique.keys()].join(", ")}. ` +
          "Pass an explicit controlPubkey.",
      );
    }
    controlPubkey = [...unique.values()][0]!;
  } else {
    controlPubkey = expectedControl;
  }

  if (allDataPubkeys.length === 0) {
    throw new Error("no BPUB multisig scripts found in this transaction");
  }

  const stream = decodePubkeysToStream(allDataPubkeys);
  const { meta, content } = await decodeStream(stream);
  return { meta, content, controlPubkey, stream, inputs };
}

/** {@link recoverFromTransaction} for a raw transaction (hex string or bytes). */
export async function recoverFromRawTransaction(
  raw: Uint8Array | string,
  options: RecoverOptions = {},
): Promise<RecoverResult> {
  return await recoverFromTransaction(deserializeTransaction(raw), options);
}

export interface OwnerOutput {
  vout: number;
  valueSats: number;
}

export interface OwnerTransfer {
  bpubId: Uint8Array;
  ownerH160: Uint8Array;
  /** Owner P2WPKH address (`bc1q...`) derived from the committed hash. */
  ownerAddress: string;
  /** P2WSH scriptPubKey of the ownership UTXO. */
  ownerScriptPubKey: Uint8Array;
  /** Outputs of this transaction that are ownership UTXOs. */
  ownerOutputs: OwnerOutput[];
}

/**
 * Decode a v5 owner-transfer (or owner-reveal-to-self) transaction by finding
 * the ownership redeem script in an input witness.
 */
export async function decodeOwnerTransfer(
  raw: Uint8Array | string | Transaction,
  hrp = "bc",
): Promise<OwnerTransfer> {
  const tx =
    typeof raw === "string" || raw instanceof Uint8Array ? deserializeTransaction(raw) : raw;

  if (!tx.hasWitness) {
    throw new Error("transaction has no witness data; cannot decode the owner script");
  }

  for (const input of tx.inputs) {
    if (input.witness.length < 2) continue;
    const redeemScript = input.witness[input.witness.length - 1]!;
    let decoded;
    try {
      decoded = decodeOwnerRedeemScript(redeemScript);
    } catch {
      continue;
    }

    const ownerScriptPubKey = await p2wshScriptPubKey(redeemScript);
    const ownerOutputs: OwnerOutput[] = [];
    for (const [vout, output] of tx.outputs.entries()) {
      if (bytesEqual(output.scriptPubKey, ownerScriptPubKey)) {
        ownerOutputs.push({ vout, valueSats: output.value });
      }
    }

    return {
      bpubId: decoded.bpubId,
      ownerH160: decoded.ownerH160,
      ownerAddress: addressFromOwnerH160(decoded.ownerH160, hrp),
      ownerScriptPubKey,
      ownerOutputs,
    };
  }

  throw new Error("no BPUB v5 owner redeemScript found in any input witness");
}
