/**
 * SHA-256, double-SHA256, HASH160, and RIPEMD-160, backed by the audited
 * `@noble/hashes` implementations. RIPEMD-160 in particular has no native
 * Web Crypto primitive, so this used to carry its own bit-for-bit reference
 * implementation (RFC 1320-style); `@noble/hashes` replaces that entirely.
 *
 * These stay declared `async` even though the underlying implementations are
 * synchronous, matching the rest of the public API (`await` on a non-Promise
 * resolves immediately, so this is not a breaking change).
 */

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { ripemd160 as nobleRipemd160 } from "@noble/hashes/legacy.js";

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return nobleSha256(data);
}

export async function sha256d(data: Uint8Array): Promise<Uint8Array> {
  return nobleSha256(nobleSha256(data));
}

/** HASH160 = RIPEMD-160(SHA-256(x)), as used by P2WPKH/P2PKH. */
export async function hash160(data: Uint8Array): Promise<Uint8Array> {
  return nobleRipemd160(nobleSha256(data));
}

export function ripemd160(data: Uint8Array): Uint8Array {
  return nobleRipemd160(data);
}
