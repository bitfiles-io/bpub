/**
 * Minimal Bitcoin transaction (de)serialisation, including SegWit witnesses.
 * Only what BPUB needs: no signing, no script execution.
 */

import { bytesToHex, concatBytes, hexToBytes, reverseBytes } from "./bytes.ts";
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

class Reader {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error(`unexpected end of transaction (wanted ${length} bytes)`);
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  uint8(): number {
    return this.take(1)[0]!;
  }

  uint32LE(): number {
    const b = this.take(4);
    return ((b[0]! | (b[1]! << 8) | (b[2]! << 16)) + b[3]! * 0x1000000) >>> 0;
  }

  uint64LE(): number {
    const b = this.take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(b[i]!);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("output value exceeds the safe integer range");
    }
    return Number(value);
  }

  varInt(): number {
    const first = this.uint8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const b = this.take(2);
      return b[0]! | (b[1]! << 8);
    }
    if (first === 0xfe) return this.uint32LE();
    return this.uint64LE();
  }

  varBytes(): Uint8Array {
    return this.take(this.varInt());
  }

  peek(): number {
    if (this.remaining === 0) throw new Error("unexpected end of transaction");
    return this.bytes[this.offset]!;
  }
}

export function encodeVarInt(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) throw new Error(`invalid varint: ${value}`);
  if (value < 0xfd) return new Uint8Array([value]);
  if (value <= 0xffff) return new Uint8Array([0xfd, value & 0xff, (value >> 8) & 0xff]);
  if (value <= 0xffffffff) {
    return new Uint8Array([
      0xfe,
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]);
  }
  const out = new Uint8Array(9);
  out[0] = 0xff;
  let big = BigInt(value);
  for (let i = 1; i <= 8; i++) {
    out[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  return out;
}

function uint32LEBytes(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function uint64LEBytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  let big = BigInt(value);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  return out;
}

function varBytes(data: Uint8Array): Uint8Array {
  return concatBytes(encodeVarInt(data.length), data);
}

/** Deserialise a raw transaction (hex string or bytes). */
export function deserializeTransaction(raw: Uint8Array | string): Transaction {
  const bytes = typeof raw === "string" ? hexToBytes(raw.trim()) : raw;
  const reader = new Reader(bytes);

  const version = reader.uint32LE();
  let hasWitness = false;

  let inputCount = reader.varInt();
  if (inputCount === 0) {
    // SegWit marker consumed as a zero input count; the next byte is the flag.
    const flag = reader.uint8();
    if (flag !== 0x01) throw new Error(`unsupported SegWit flag: ${flag}`);
    hasWitness = true;
    inputCount = reader.varInt();
  }

  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputs.push({
      prevTxid: reader.take(32).slice(),
      prevIndex: reader.uint32LE(),
      scriptSig: reader.varBytes().slice(),
      sequence: reader.uint32LE(),
      witness: [],
    });
  }

  const outputCount = reader.varInt();
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputs.push({
      value: reader.uint64LE(),
      scriptPubKey: reader.varBytes().slice(),
    });
  }

  if (hasWitness) {
    for (const input of inputs) {
      const itemCount = reader.varInt();
      const stack: Uint8Array[] = [];
      for (let i = 0; i < itemCount; i++) stack.push(reader.varBytes().slice());
      input.witness = stack;
    }
  }

  const lockTime = reader.uint32LE();
  return { version, inputs, outputs, lockTime, hasWitness };
}

/**
 * Serialise a transaction. The SegWit marker/flag is emitted only when at least
 * one input carries witness data, matching Bitcoin Core and `bitcointx`.
 */
export function serializeTransaction(tx: Transaction): Uint8Array {
  const includeWitness = tx.inputs.some((input) => input.witness.length > 0);
  const parts: Uint8Array[] = [uint32LEBytes(tx.version)];

  if (includeWitness) parts.push(new Uint8Array([0x00, 0x01]));

  parts.push(encodeVarInt(tx.inputs.length));
  for (const input of tx.inputs) {
    if (input.prevTxid.length !== 32) throw new Error("prevTxid must be 32 bytes");
    parts.push(
      input.prevTxid,
      uint32LEBytes(input.prevIndex),
      varBytes(input.scriptSig),
      uint32LEBytes(input.sequence),
    );
  }

  parts.push(encodeVarInt(tx.outputs.length));
  for (const output of tx.outputs) {
    parts.push(uint64LEBytes(output.value), varBytes(output.scriptPubKey));
  }

  if (includeWitness) {
    for (const input of tx.inputs) {
      parts.push(encodeVarInt(input.witness.length));
      for (const item of input.witness) parts.push(varBytes(item));
    }
  }

  parts.push(uint32LEBytes(tx.lockTime));
  return concatBytes(...parts);
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
