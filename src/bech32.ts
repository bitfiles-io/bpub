/**
 * Bech32 / Bech32m (BIP-173, BIP-350) and SegWit address conversion.
 *
 * Upstream leans on `bitcointx`'s address classes; this is a self-contained
 * replacement so the library has no dependencies.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export type Bech32Encoding = "bech32" | "bech32m";

const CHECKSUM_CONSTANT: Record<Bech32Encoding, number> = {
  bech32: 1,
  bech32m: 0x2bc830a3,
};

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** Encode 5-bit groups with a bech32/bech32m checksum. */
export function bech32Encode(hrp: string, data: number[], encoding: Bech32Encoding): string {
  const values = [...hrpExpand(hrp), ...data];
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ CHECKSUM_CONSTANT[encoding];
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  let out = `${hrp}1`;
  for (const value of [...data, ...checksum]) out += CHARSET[value]!;
  return out;
}

export interface Bech32Decoded {
  hrp: string;
  /** Payload as 5-bit groups, checksum removed. */
  data: number[];
  encoding: Bech32Encoding;
}

/** Decode a bech32/bech32m string, validating the checksum and character set. */
export function bech32Decode(address: string): Bech32Decoded {
  if (address.length < 8 || address.length > 90) {
    throw new Error(`invalid bech32 length: ${address.length}`);
  }
  const hasLower = address !== address.toUpperCase();
  const hasUpper = address !== address.toLowerCase();
  if (hasLower && hasUpper) throw new Error("mixed case in bech32 string");

  const lower = address.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (separator < 1 || separator + 7 > lower.length) {
    throw new Error("invalid bech32 separator position");
  }
  const hrp = lower.slice(0, separator);
  for (let i = 0; i < hrp.length; i++) {
    const code = hrp.charCodeAt(i);
    if (code < 33 || code > 126) throw new Error("invalid character in bech32 hrp");
  }

  const data: number[] = [];
  for (const char of lower.slice(separator + 1)) {
    const value = CHARSET.indexOf(char);
    if (value === -1) throw new Error(`invalid bech32 character: ${char}`);
    data.push(value);
  }

  const values = [...hrpExpand(hrp), ...data];
  const mod = polymod(values);
  let encoding: Bech32Encoding;
  if (mod === CHECKSUM_CONSTANT.bech32) {
    encoding = "bech32";
  } else if (mod === CHECKSUM_CONSTANT.bech32m) {
    encoding = "bech32m";
  } else {
    throw new Error("invalid bech32 checksum");
  }

  return { hrp, data: data.slice(0, -6), encoding };
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxValue = (1 << to) - 1;
  const maxAcc = (1 << (from + to - 1)) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i]!;
    if (value < 0 || value >> from !== 0) throw new Error("invalid value for bit conversion");
    acc = ((acc << from) | value) & maxAcc;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxValue);
  } else if (bits >= from || ((acc << (to - bits)) & maxValue) !== 0) {
    throw new Error("invalid padding in bit conversion");
  }
  return out;
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

  const program = Uint8Array.from(convertBits(data.slice(1), 5, 8, false));
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
  const data = [version, ...convertBits(program, 8, 5, true)];
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
