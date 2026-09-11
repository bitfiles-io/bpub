import { toArrayBuffer } from "./bytes.ts";

/** SHA-256 via Web Crypto (present in browsers and Node >= 18). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("crypto.subtle is unavailable; a secure context or Node >= 18 is required");
  }
  const digest = await subtle.digest("SHA-256", toArrayBuffer(data));
  return new Uint8Array(digest);
}

export async function sha256d(data: Uint8Array): Promise<Uint8Array> {
  return await sha256(await sha256(data));
}

/** HASH160 = RIPEMD-160(SHA-256(x)), as used by P2WPKH/P2PKH. */
export async function hash160(data: Uint8Array): Promise<Uint8Array> {
  return ripemd160(await sha256(data));
}

// --- RIPEMD-160 -------------------------------------------------------------
// Web Crypto has no RIPEMD-160, so it is implemented here (RFC 1320-style
// reference algorithm). Verified against the standard test vectors in the
// test suite.

const RMD_R = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
  4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
]);

const RMD_R_PRIME = new Uint8Array([
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
  12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
]);

const RMD_S = new Uint8Array([
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
  9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
]);

const RMD_S_PRIME = new Uint8Array([
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
  8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
]);

const RMD_K = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const RMD_K_PRIME = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) | 0;
}

function rmdF(round: number, x: number, y: number, z: number): number {
  switch (round) {
    case 0:
      return x ^ y ^ z;
    case 1:
      return (x & y) | (~x & z);
    case 2:
      return (x | ~y) ^ z;
    case 3:
      return (x & z) | (y & ~z);
    default:
      return x ^ (y | ~z);
  }
}

export function ripemd160(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 8) >> 6 << 6) + 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const x = new Int32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) x[i] = view.getInt32(offset + i * 4, true);

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let aP = h0;
    let bP = h1;
    let cP = h2;
    let dP = h3;
    let eP = h4;

    for (let j = 0; j < 80; j++) {
      const round = Math.floor(j / 16);
      let t = (a + rmdF(round, b, c, d) + x[RMD_R[j]!]! + RMD_K[round]!) | 0;
      t = (rotl(t, RMD_S[j]!) + e) | 0;
      a = e;
      e = d;
      d = rotl(c, 10);
      c = b;
      b = t;

      let tP = (aP + rmdF(4 - round, bP, cP, dP) + x[RMD_R_PRIME[j]!]! + RMD_K_PRIME[round]!) | 0;
      tP = (rotl(tP, RMD_S_PRIME[j]!) + eP) | 0;
      aP = eP;
      eP = dP;
      dP = rotl(cP, 10);
      cP = bP;
      bP = tP;
    }

    const t = (h1 + c + dP) | 0;
    h1 = (h2 + d + eP) | 0;
    h2 = (h3 + e + aP) | 0;
    h3 = (h4 + a + bP) | 0;
    h4 = (h0 + b + cP) | 0;
    h0 = t;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, h0, true);
  outView.setInt32(4, h1, true);
  outView.setInt32(8, h2, true);
  outView.setInt32(12, h3, true);
  outView.setInt32(16, h4, true);
  return out;
}
