/**
 * Bech32 / Bech32m (BIP-173, BIP-350) and SegWit address conversion.
 *
 * The checksum algorithm and 5-bit/8-bit regrouping are standard and now come
 * from `@scure/base`'s audited `bech32`/`bech32m` coders. What stays here is
 * BPUB-specific: the witness-version/program validation rules and the
 * ownership-address helpers built on top.
 */

import { bech32 as scureBech32, bech32m as scureBech32m } from "@scure/base";

export type Bech32Encoding = "bech32" | "bech32m";

/** Encode 5-bit groups with a bech32/bech32m checksum. */
export function bech32Encode(hrp: string, data: number[], encoding: Bech32Encoding): string {
  const coder = encoding === "bech32" ? scureBech32 : scureBech32m;
  return coder.encode(hrp, data);
}

export interface Bech32Decoded {
  hrp: string;
  /** Payload as 5-bit groups, checksum removed. */
  data: number[];
  encoding: Bech32Encoding;
}

/** Decode a bech32/bech32m string, validating the checksum and character set. */
export function bech32Decode(address: string): Bech32Decoded {
  const asBech32 = scureBech32.decodeUnsafe(address);
  if (asBech32) return { hrp: asBech32.prefix, data: asBech32.words, encoding: "bech32" };

  const asBech32m = scureBech32m.decodeUnsafe(address);
  if (asBech32m) return { hrp: asBech32m.prefix, data: asBech32m.words, encoding: "bech32m" };

  throw new Error("invalid bech32 string (bad checksum, character set, or length)");
}

export interface WitnessProgram {
  version: number;
  program: Uint8Array;
}

/** Decode a SegWit address into its witness version and program. */
export function decodeSegwitAddress(address: string, expectedHrp = "bc"): WitnessProgram {
  const { hrp, data, encoding } = bech32Decode(address);
  if (hrp !== expectedHrp) {
    throw new Error(`unexpected address prefix: ${hrp} (expected ${expectedHrp})`);
  }
  if (data.length === 0) throw new Error("empty witness program");

  const version = data[0]!;
  if (version > 16) throw new Error(`invalid witness version: ${version}`);
  if (version === 0 && encoding !== "bech32") {
    throw new Error("witness v0 addresses must use bech32");
  }
  if (version !== 0 && encoding !== "bech32m") {
    throw new Error("witness v1+ addresses must use bech32m");
  }

  const coder = encoding === "bech32" ? scureBech32 : scureBech32m;
  let program: Uint8Array;
  try {
    program = coder.fromWords(data.slice(1));
  } catch (error) {
    throw new Error(`invalid witness program padding: ${(error as Error).message}`);
  }
  if (program.length < 2 || program.length > 40) {
    throw new Error(`invalid witness program length: ${program.length}`);
  }
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error(`invalid witness v0 program length: ${program.length}`);
  }
  return { version, program };
}

/** Encode a witness version and program as a SegWit address. */
export function encodeSegwitAddress(
  version: number,
  program: Uint8Array,
  hrp = "bc",
): string {
  if (version < 0 || version > 16) throw new Error(`invalid witness version: ${version}`);
  if (program.length < 2 || program.length > 40) {
    throw new Error(`invalid witness program length: ${program.length}`);
  }
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error(`invalid witness v0 program length: ${program.length}`);
  }
  const coder = version === 0 ? scureBech32 : scureBech32m;
  const data = [version, ...coder.toWords(program)];
  return bech32Encode(hrp, data, version === 0 ? "bech32" : "bech32m");
}

/**
 * Convert a bech32/bech32m SegWit address (P2WPKH, P2WSH or P2TR) into its raw
 * scriptPubKey bytes.
 */
export function addressToScriptPubKey(address: string, hrp = "bc"): Uint8Array {
  const { version, program } = decodeSegwitAddress(address, hrp);
  const out = new Uint8Array(2 + program.length);
  out[0] = version === 0 ? 0x00 : 0x50 + version;
  out[1] = program.length;
  out.set(program, 2);
  return out;
}

/** Inverse of {@link addressToScriptPubKey} for witness scriptPubKeys. */
export function scriptPubKeyToAddress(scriptPubKey: Uint8Array, hrp = "bc"): string {
  if (scriptPubKey.length < 4) throw new Error("scriptPubKey is too short to be a witness program");
  const first = scriptPubKey[0]!;
  const version = first === 0x00 ? 0 : first - 0x50;
  if (version < 0 || version > 16) throw new Error("not a witness scriptPubKey");
  const length = scriptPubKey[1]!;
  if (scriptPubKey.length !== 2 + length) throw new Error("malformed witness scriptPubKey");
  return encodeSegwitAddress(version, scriptPubKey.subarray(2), hrp);
}

/**
 * HASH160(pubkey) for a BPUB owner, taken from a P2WPKH (`bc1q`, 20-byte
 * program) address. P2WSH and P2TR owner addresses are rejected, matching
 * upstream.
 */
export function ownerH160FromAddress(address: string, hrp = "bc"): Uint8Array {
  const { version, program } = decodeSegwitAddress(address, hrp);
  if (version !== 0 || program.length !== 20) {
    throw new Error("owner address must be a P2WPKH bc1q... address");
  }
  return program;
}

/** P2WPKH address for an owner pubkey hash. */
export function addressFromOwnerH160(h160: Uint8Array, hrp = "bc"): string {
  if (h160.length !== 20) throw new Error("ownerH160 must be 20 bytes");
  return encodeSegwitAddress(0, h160, hrp);
}
