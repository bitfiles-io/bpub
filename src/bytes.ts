/**
 * Small byte helpers. Everything in this library speaks `Uint8Array`, never
 * Node `Buffer`, so the same code runs in the browser.
 */

const HEX_CHARS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[b >> 4]! + HEX_CHARS[b & 0x0f]!;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at offset ${i * 2}: ${clean.slice(i * 2, i * 2 + 2)}`);
    }
    out[i] = byte;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i]!;
  return out;
}

/** Read a big-endian unsigned integer of `length` bytes as a JS number. */
export function readUintBE(bytes: Uint8Array, offset: number, length: number): number {
  if (offset + length > bytes.length) {
    throw new Error(`readUintBE out of range: need ${length} bytes at ${offset}`);
  }
  let value = 0n;
  for (let i = 0; i < length; i++) {
    value = (value << 8n) | BigInt(bytes[offset + i]!);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`integer too large for a JS number: ${value}`);
  }
  return Number(value);
}

/** Encode an unsigned integer as `length` big-endian bytes. */
export function uintToBytesBE(value: number, length: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`not a non-negative integer: ${value}`);
  }
  let big = BigInt(value);
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  if (big !== 0n) {
    throw new Error(`value ${value} does not fit in ${length} bytes`);
  }
  return out;
}

export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]!);
  }
  return value;
}

/** Present a `Uint8Array` to Web APIs that want a plain `ArrayBuffer` view. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
