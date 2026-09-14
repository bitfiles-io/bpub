/**
 * Bitcoin transaction (de)serialisation, including SegWit witnesses.
 *
 * The wire format itself (varints, inputs, outputs, witness stacks) is
 * standard Bitcoin, so this delegates to `@scure/btc-signer`'s `RawTx` coder
 * instead of a hand-rolled reader/writer. What stays here is just the
 * translation to/from BPUB's own `Transaction`/`TxInput`/`TxOutput` shape
 * (`value`/`prevTxid`/`prevIndex` as plain numbers and internal-order bytes),
 * which the rest of this library and its public API are built around.
 */

import { RawTx } from "@scure/btc-signer";
import { CompactSizeLen } from "@scure/btc-signer/script.js";

import { bytesToHex, hexToBytes, reverseBytes } from "./bytes.ts";
import { sha256d } from "./hash.ts";

export interface TxInput {
  /** Previous txid in internal byte order (reverse of the displayed hex). */
  prevTxid: Uint8Array;
  prevIndex: number;
  scriptSig: Uint8Array;
  sequence: number;
  /** Witness stack; empty when the input has no witness. */
  witness: Uint8Array[];
}

export interface TxOutput {
  /** Value in satoshis. */
  value: number;
  scriptPubKey: Uint8Array;
}

export interface Transaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
  /** True when the transaction was serialised with the SegWit marker/flag. */
  hasWitness: boolean;
}

function amountToSats(amount: bigint): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("output value exceeds the safe integer range");
  }
  return Number(amount);
}

/** Encode a Bitcoin CompactSize ("varint"). */
export function encodeVarInt(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) throw new Error(`invalid varint: ${value}`);
  return CompactSizeLen.encode(value);
}

/** Deserialise a raw transaction (hex string or bytes). */
export function deserializeTransaction(raw: Uint8Array | string): Transaction {
  const bytes = typeof raw === "string" ? hexToBytes(raw.trim()) : raw;
  const decoded = RawTx.decode(bytes);
  const hasWitness = Boolean(decoded.segwitFlag);
  const witnesses = decoded.witnesses ?? [];

  return {
    version: decoded.version,
    inputs: decoded.inputs.map((input, i) => ({
      prevTxid: input.txid,
      prevIndex: input.index,
      scriptSig: input.finalScriptSig,
      sequence: input.sequence,
      witness: hasWitness ? (witnesses[i] ?? []) : [],
    })),
    outputs: decoded.outputs.map((output) => ({
      value: amountToSats(output.amount),
      scriptPubKey: output.script,
    })),
    lockTime: decoded.lockTime,
    hasWitness,
  };
}

/**
 * Serialise a transaction. The SegWit marker/flag is emitted only when at least
 * one input carries witness data, matching Bitcoin Core and `bitcointx`.
 */
export function serializeTransaction(tx: Transaction): Uint8Array {
  const includeWitness = tx.inputs.some((input) => input.witness.length > 0);
  for (const input of tx.inputs) {
    if (input.prevTxid.length !== 32) throw new Error("prevTxid must be 32 bytes");
  }
  return RawTx.encode({
    version: tx.version,
    segwitFlag: includeWitness,
    inputs: tx.inputs.map((input) => ({
      txid: input.prevTxid,
      index: input.prevIndex,
      finalScriptSig: input.scriptSig,
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map((output) => ({
      amount: BigInt(output.value),
      script: output.scriptPubKey,
    })),
    witnesses: includeWitness ? tx.inputs.map((input) => input.witness) : undefined,
    lockTime: tx.lockTime,
  });
}

/** Transaction id (double-SHA256 of the witness-stripped serialisation), display order. */
export async function transactionId(tx: Transaction): Promise<string> {
  const stripped: Transaction = {
    ...tx,
    inputs: tx.inputs.map((input) => ({ ...input, witness: [] })),
  };
  return bytesToHex(reverseBytes(await sha256d(serializeTransaction(stripped))));
}

/** Displayed (reversed) hex form of an input's previous txid. */
export function prevTxidHex(input: TxInput): string {
  return bytesToHex(reverseBytes(input.prevTxid));
}

/** Parse a displayed txid into internal byte order. */
export function txidToBytes(txid: string): Uint8Array {
  const bytes = hexToBytes(txid);
  if (bytes.length !== 32) throw new Error("txid must be 32 bytes");
  return reverseBytes(bytes);
}
