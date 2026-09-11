import {
  bytesEqual,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  readUintBE,
  uintToBytesBE,
  utf8ToBytes,
} from "./bytes.ts";
import { FLAG_COMPRESSED, FLAG_METADATA, V4_XOR_SALT } from "./constants.ts";
import { rawDeflate, rawInflate, zlibDeflate } from "./compress.ts";
import { sha256 } from "./hash.ts";

/** Metadata recovered from a BPUB stream. Mirrors the upstream `meta` dict. */
export interface BpubMeta {
  /** 1 for legacy v3.5 streams (header version byte), otherwise 4 or 5. */
  bpubVersion: number;
  /** Length of the uncompressed content in bytes. */
  size: number;
  /** SHA-256 committed in the header. */
  sha: Uint8Array;
  mime?: string;
  filename?: string;
  /** v5 only: inscription id committed in the ownership script. */
  bpubId?: Uint8Array;
  /** Set instead of mime/filename when the metadata blob could not be parsed. */
  metaBlob?: Uint8Array;
}

export interface DecodedStream {
  meta: BpubMeta;
  content: Uint8Array;
}

export interface BuildStreamOptions {
  mime?: string;
  filename?: string;
  /** Compress the content before the XOR pass. */
  compress?: boolean;
}

/** XOR with the fixed public salt; symmetric for obfuscate/deobfuscate. */
export function xorObfuscate(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ V4_XOR_SALT[i % V4_XOR_SALT.length]!;
  }
  return out;
}

/**
 * Canonical BPUB v5 id for uncompressed content:
 * `sha256("BPUB5" || sha256(data) || size_be_8)`.
 */
export async function computeBpubV5Id(data: Uint8Array): Promise<Uint8Array> {
  const shaUncompressed = await sha256(data);
  return await sha256(
    concatBytes(utf8ToBytes("BPUB5"), shaUncompressed, uintToBytesBE(data.length, 8)),
  );
}

/**
 * Build a legacy BPUB v3.5 stream:
 * `["BPUB"][version=1][header_len(3)][TLV header][content]`.
 *
 * TLVs: 0x01 size(8), 0x02 sha256(content)(32), 0x03 mime, 0x05 filename,
 * 0xFF terminator. Note that v3.5 commits to the sha256 of the *stored* bytes,
 * and that `compress` here means zlib-wrapped DEFLATE, matching upstream.
 */
export async function buildStreamV35(
  data: Uint8Array,
  options: BuildStreamOptions = {},
): Promise<Uint8Array> {
  const { mime = "", filename = "", compress = false } = options;
  const content = compress ? await zlibDeflate(data) : data;

  const parts: Uint8Array[] = [
    concatBytes(new Uint8Array([0x01, 8]), uintToBytesBE(content.length, 8)),
    concatBytes(new Uint8Array([0x02, 32]), await sha256(content)),
  ];
  const mimeBytes = utf8ToBytes(mime);
  parts.push(concatBytes(new Uint8Array([0x03, mimeBytes.length]), mimeBytes));
  if (filename) {
    const filenameBytes = utf8ToBytes(filename);
    parts.push(concatBytes(new Uint8Array([0x05, filenameBytes.length]), filenameBytes));
  }
  parts.push(new Uint8Array([0xff, 0]));

  const header = concatBytes(...parts);
  return concatBytes(
    utf8ToBytes("BPUB"),
    new Uint8Array([1]),
    uintToBytesBE(header.length, 3),
    header,
    content,
  );
}

async function buildStreamV4OrV5(
  version: 4 | 5,
  data: Uint8Array,
  options: BuildStreamOptions,
): Promise<Uint8Array> {
  const { mime = "", filename = "", compress = false } = options;
  let flags = 0;
  const shaUncompressed = await sha256(data);

  // Key order matters only for byte-for-byte reproducibility; it matches upstream.
  const metaDict: Record<string, string> = {};
  if (version === 5) {
    metaDict["bpub_id"] = bytesToHex(
      await sha256(
        concatBytes(utf8ToBytes("BPUB5"), shaUncompressed, uintToBytesBE(data.length, 8)),
      ),
    );
  }
  if (mime) metaDict["mime"] = mime;
  if (filename) metaDict["filename"] = filename;

  let metaBlobEnc: Uint8Array = new Uint8Array(0);
  if (Object.keys(metaDict).length > 0) {
    metaBlobEnc = xorObfuscate(await rawDeflate(utf8ToBytes(JSON.stringify(metaDict))));
    flags |= FLAG_METADATA;
  }
  if (metaBlobEnc.length > 0xffff) {
    throw new Error(`metadata too large for the v${version} header (max 65535 bytes)`);
  }

  let contentPlain: Uint8Array = data;
  if (compress && data.length > 0) {
    contentPlain = await rawDeflate(data);
    flags |= FLAG_COMPRESSED;
  }

  const body = concatBytes(
    new Uint8Array([version, flags]),
    uintToBytesBE(data.length, 8),
    shaUncompressed,
    uintToBytesBE(metaBlobEnc.length, 2),
    metaBlobEnc,
    xorObfuscate(contentPlain),
  );
  if (body.length > 0xffffffff) {
    throw new Error(`BPUB v${version} stream too large (body exceeds the 4-byte prefix)`);
  }
  return concatBytes(uintToBytesBE(body.length, 4), body);
}

/**
 * Build a BPUB v4 stream (stealth, no ownership):
 * ```
 * [0:4]   body_len (uint32 BE)
 * [4]     version = 4
 * [5]     flags
 * [6:14]  size_uncompressed (uint64 BE)
 * [14:46] sha256(uncompressed)
 * [46:48] meta_len (uint16 BE)
 * [48:..] meta_blob_enc = XOR(raw_deflate(JSON))
 * [..]    content_enc = XOR(raw_deflate(data) | data)
 * ```
 */
export function buildStreamV4(
  data: Uint8Array,
  options: BuildStreamOptions = {},
): Promise<Uint8Array> {
  return buildStreamV4OrV5(4, data, options);
}

/** Build a BPUB v5 stream: same layout as v4, plus `bpub_id` in the metadata. */
export function buildStreamV5(
  data: Uint8Array,
  options: BuildStreamOptions = {},
): Promise<Uint8Array> {
  return buildStreamV4OrV5(5, data, options);
}

async function decodeStreamV35(payload: Uint8Array): Promise<DecodedStream> {
  const version = payload[4];
  if (version !== 1) {
    throw new Error(`unsupported BPUB version: ${version}`);
  }

  const headerLen = readUintBE(payload, 5, 3);
  const header = payload.subarray(8, 8 + headerLen);

  const meta: BpubMeta = { bpubVersion: 1, size: -1, sha: new Uint8Array(0) };
  let sawSize = false;
  let sawSha = false;
  let i = 0;
  while (i + 1 < header.length) {
    const type = header[i]!;
    const len = header[i + 1]!;
    const value = header.subarray(i + 2, i + 2 + len);
    if (type === 0xff) break;
    if (type === 0x01) {
      meta.size = readUintBE(value, 0, value.length);
      sawSize = true;
    } else if (type === 0x02) {
      meta.sha = value.slice();
      sawSha = true;
    } else if (type === 0x03) {
      meta.mime = bytesToUtf8(value);
    } else if (type === 0x05) {
      meta.filename = bytesToUtf8(value);
    }
    i += 2 + len;
  }

  if (!sawSize || !sawSha) {
    throw new Error("missing mandatory metadata (size/sha) in the BPUB header");
  }

  const start = 8 + headerLen;
  const content = payload.slice(start, start + meta.size);
  if (!bytesEqual(await sha256(content), meta.sha)) {
    throw new Error("SHA-256 mismatch in content");
  }
  return { meta, content };
}

/**
 * Decode a BPUB stream (legacy v3.5, or v4/v5 stealth).
 *
 * Verifies the committed length and SHA-256, and inflates the content when the
 * compression flag is set. Trailing zero padding added by the pubkey encoder is
 * ignored, because the 4-byte length prefix bounds the body exactly.
 */
export async function decodeStream(payload: Uint8Array): Promise<DecodedStream> {
  if (
    payload.length >= 5 &&
    payload[0] === 0x42 &&
    payload[1] === 0x50 &&
    payload[2] === 0x55 &&
    payload[3] === 0x42
  ) {
    return await decodeStreamV35(payload);
  }

  if (payload.length === 0) throw new Error("empty BPUB payload");
  if (payload.length < 4) throw new Error("truncated BPUB v4/v5 length prefix");

  const bodyLen = readUintBE(payload, 0, 4);
  if (bodyLen <= 0) throw new Error("invalid BPUB v4/v5 body length");
  if (4 + bodyLen > payload.length) {
    throw new Error("truncated BPUB v4/v5 stream (missing bytes)");
  }

  const body = payload.subarray(4, 4 + bodyLen);
  if (body.length < 1 + 1 + 8 + 32 + 2) {
    throw new Error("truncated BPUB v4/v5 header");
  }

  const version = body[0]!;
  if (version !== 4 && version !== 5) {
    throw new Error(`unsupported BPUB version without magic: ${version}`);
  }

  const flags = body[1]!;
  const sizeUncompressed = readUintBE(body, 2, 8);
  const shaUncompressed = body.slice(10, 42);
  const metaLen = readUintBE(body, 42, 2);
  if (body.length < 44 + metaLen) {
    throw new Error("truncated BPUB v4/v5 meta section");
  }

  const metaBlobEnc = body.subarray(44, 44 + metaLen);
  const contentEnc = body.subarray(44 + metaLen);

  const meta: BpubMeta = {
    bpubVersion: version,
    size: sizeUncompressed,
    sha: shaUncompressed,
  };

  if (metaLen > 0) {
    try {
      const metaJson: unknown = JSON.parse(
        bytesToUtf8(await rawInflate(xorObfuscate(metaBlobEnc))),
      );
      if (metaJson && typeof metaJson === "object" && !Array.isArray(metaJson)) {
        const fields = metaJson as Record<string, unknown>;
        if (typeof fields["mime"] === "string") meta.mime = fields["mime"];
        if (typeof fields["filename"] === "string") meta.filename = fields["filename"];
        if (typeof fields["bpub_id"] === "string") {
          try {
            meta.bpubId = hexToBytes(fields["bpub_id"]);
          } catch {
            // Leave the unparsable id out rather than guessing at its encoding.
          }
        }
      }
    } catch {
      meta.metaBlob = metaBlobEnc.slice();
    }
  }

  const contentPlain = xorObfuscate(contentEnc);
  const content = flags & FLAG_COMPRESSED ? await rawInflate(contentPlain) : contentPlain;

  if (content.length !== sizeUncompressed) {
    throw new Error(
      `size mismatch in v${version} content: header=${sizeUncompressed}, got=${content.length}`,
    );
  }
  if (!bytesEqual(await sha256(content), shaUncompressed)) {
    throw new Error("SHA-256 mismatch in v4/v5 content");
  }

  if (version === 5 && !meta.bpubId) {
    meta.bpubId = await computeBpubV5Id(content);
  }

  return { meta, content };
}
