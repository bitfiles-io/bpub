import { bytesToBigIntBE } from "./bytes.ts";
import { CHUNK_SIZE, MAX_DATA_PUBKEYS_PER_SCRIPT } from "./constants.ts";
import { liftX } from "./curve.ts";

/**
 * Encode arbitrary bytes into a list of valid compressed secp256k1 pubkeys.
 *
 * The stream is split into 31-byte chunks; a 1-byte nonce is appended and the
 * resulting 32 bytes are treated as an x-coordinate. The nonce is ground until
 * x lies on the curve, and the pubkey is emitted in compressed SEC form:
 *
 *     [0x02 | (y & 1)] [31-byte chunk] [nonce]
 *
 * A short final chunk is zero-padded, so the decoded stream is always a
 * multiple of 31 bytes; the BPUB stream header carries the real length.
 */
export function encodeStreamToPubkeys(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < stream.length; i += CHUNK_SIZE) {
    const pubkey = new Uint8Array(33);
    pubkey.set(stream.subarray(i, i + CHUNK_SIZE), 1);
    const xBytes = pubkey.subarray(1, 33);

    let found = false;
    for (let nonce = 0; nonce < 256; nonce++) {
      xBytes[CHUNK_SIZE] = nonce;
      const y = liftX(bytesToBigIntBE(xBytes));
      if (y === null) continue;
      pubkey[0] = 0x02 | Number(y & 1n);
      found = true;
      break;
    }
    if (!found) {
      throw new Error(`no valid nonce found for chunk at offset ${i} (unexpected)`);
    }
    out.push(pubkey);
  }
  return out;
}

/**
 * Reverse of {@link encodeStreamToPubkeys}: drop the SEC prefix and the trailing
 * grind nonce from each pubkey and concatenate the 31-byte chunks.
 *
 * The caller is responsible for trimming padding and interpreting the BPUB
 * header (see {@link decodeStream}).
 */
export function decodePubkeysToStream(pubkeys: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pubkeys.length * CHUNK_SIZE);
  let offset = 0;
  for (const pk of pubkeys) {
    if (pk.length !== 33) {
      throw new Error(`data pubkey must be 33 bytes, got ${pk.length}`);
    }
    out.set(pk.subarray(1, 1 + CHUNK_SIZE), offset);
    offset += CHUNK_SIZE;
  }
  return out;
}

/** Split data pubkeys into groups that each fit in one 1-of-15 multisig script. */
export function chunkDataPubkeys(
  pubkeys: Uint8Array[],
  perScript: number = MAX_DATA_PUBKEYS_PER_SCRIPT,
): Uint8Array[][] {
  if (perScript < 1) throw new Error("perScript must be >= 1");
  const chunks: Uint8Array[][] = [];
  for (let i = 0; i < pubkeys.length; i += perScript) {
    chunks.push(pubkeys.slice(i, i + perScript));
  }
  return chunks;
}
