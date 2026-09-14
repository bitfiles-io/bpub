/** Constants shared by the BPUB encoder and decoder (see docs/01_spec.md upstream). */

import { OP } from "@scure/btc-signer/script.js";

/** secp256k1 field prime: y^2 = x^3 + 7 over F_p. */
export const P = 2n ** 256n - 2n ** 32n - 977n;

/** secp256k1 curve parameter `b`. */
export const CURVE_B = 7n;

/**
 * Standardness historically limits bare multisig to 15 pubkeys per script,
 * giving 14 data pubkeys + 1 control pubkey.
 */
export const MAX_PUBKEYS_PER_SCRIPT = 15;

/** Data pubkeys that fit in one 1-of-15 multisig script. */
export const MAX_DATA_PUBKEYS_PER_SCRIPT = MAX_PUBKEYS_PER_SCRIPT - 1;

/** Bytes of payload carried by a single fake pubkey (33 = 1 prefix + 31 data + 1 nonce). */
export const CHUNK_SIZE = 31;

/** XOR obfuscation salt for v4/v5 streams (public and fixed; not a secret). */
export const V4_XOR_SALT = new Uint8Array([0x53, 0x6a, 0x19, 0xa1]);

/** Flag bit: content was raw-DEFLATE compressed before the XOR pass. */
export const FLAG_COMPRESSED = 0x01;

/** Flag bit: a metadata blob is present. */
export const FLAG_METADATA = 0x02;

/** Dust threshold used by the upstream funding-tx builder. */
export const DUST = 546;

export const OP_0 = OP.OP_0;
export const OP_1 = OP.OP_1;
export const OP_16 = OP.OP_16;
export const OP_PUSHDATA1 = OP.PUSHDATA1;
export const OP_PUSHDATA2 = OP.PUSHDATA2;
export const OP_PUSHDATA4 = OP.PUSHDATA4;
export const OP_DROP = OP.DROP;
export const OP_DUP = OP.DUP;
export const OP_EQUALVERIFY = OP.EQUALVERIFY;
export const OP_HASH160 = OP.HASH160;
export const OP_CHECKSIG = OP.CHECKSIG;
export const OP_CHECKMULTISIG = OP.CHECKMULTISIG;
