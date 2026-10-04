/**
 * Multipart files: a file too large for one reveal transaction is split across
 * several "part" inscriptions, tied together by a "manifest" inscription whose
 * txid is the file's link.
 *
 * Both are ordinary v5 inscriptions, so nothing about the stream format
 * changes; readers that don't know about manifests just see a JSON file.
 *
 * - The whole file is optionally raw-DEFLATE compressed once, then the result
 *   is sliced into parts. Compressing before slicing compresses better than
 *   compressing each part, so part streams are stored uncompressed.
 * - Each part is inscribed with mime {@link MULTIPART_PART_MIME}, so indexers
 *   can hide parts without first finding the manifest that references them.
 * - The manifest is inscribed with mime {@link MULTIPART_MANIFEST_MIME} and
 *   holds the file's real mime/filename, the SHA-256 and size of the
 *   reassembled file, and the parts' txids in order.
 *
 * Manifest JSON (version 1):
 * ```json
 * {
 *   "bpub_manifest": 1,
 *   "mime": "video/mp4",
 *   "filename": "clip.mp4",
 *   "size": 1048576,
 *   "sha256": "<hex sha256 of the reassembled, uncompressed file>",
 *   "compression": "deflate-raw",
 *   "parts": ["<txid>", "<txid>"]
 * }
 * ```
 *
 * Each part's own stream header commits to its SHA-256, which decoding checks,
 * so the manifest only needs txids. The file's v5 bpub id is derived from `sha256` and `size`, so a multipart
 * file has the same id it would have had as a single inscription.
 */

import {
  bytesEqual,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  uintToBytesBE,
  utf8ToBytes,
} from "./bytes.ts";
import { rawDeflate, rawInflate } from "./compress.ts";
import { sha256 } from "./hash.ts";
import { buildStreamV5, computeBpubV5Id } from "./stream.ts";
import type { BpubMeta } from "./stream.ts";

/** Mime of a manifest inscription. */
export const MULTIPART_MANIFEST_MIME = "application/vnd.bpub.manifest+json";

/** Mime of a part inscription. Build part streams with this mime and no compression. */
export const MULTIPART_PART_MIME = "application/vnd.bpub.part";

/** Version written to, and the only one accepted from, `bpub_manifest`. */
export const MULTIPART_MANIFEST_VERSION = 1;

export type MultipartCompression = "none" | "deflate-raw";

export interface MultipartPlanOptions {
  /** Largest v5 stream, in bytes, that one part inscription may encode to. */
  maxStreamBytes: number;
  /**
   * Compress the file before splitting. Defaults to `"auto"`, which keeps the
   * compressed form only when it's smaller.
   */
  compress?: boolean | "auto";
}

export interface MultipartPlan {
  /** Size of the uncompressed file. */
  size: number;
  /** SHA-256 of the uncompressed file. */
  sha256: Uint8Array;
  /** v5 bpub id of the uncompressed file. */
  bpubId: Uint8Array;
  compression: MultipartCompression;
  /** Bytes to inscribe, in order: `buildInscription(part, { mime: MULTIPART_PART_MIME })`. */
  parts: Uint8Array[];
}

export interface BpubManifest {
  version: number;
  mime?: string;
  filename?: string;
  size: number;
  sha256: Uint8Array;
  compression: MultipartCompression;
  /** Txids of the part inscriptions, in order. */
  parts: string[];
}

export interface ManifestFields {
  mime?: string;
  filename?: string;
}

/** True when recovered metadata marks the inscription as a multipart manifest. */
export function isManifestMeta(meta: BpubMeta): boolean {
  return meta.mime === MULTIPART_MANIFEST_MIME;
}

/** True when recovered metadata marks the inscription as one part of a multipart file. */
export function isPartMeta(meta: BpubMeta): boolean {
  return meta.mime === MULTIPART_PART_MIME;
}

/** Bytes a part stream adds on top of its data, before the v5 metadata blob. */
const V5_FIXED_OVERHEAD = 4 + 1 + 1 + 8 + 32 + 2;
/** Generous first guess at the deflated part metadata (`bpub_id` + mime); corrected below. */
const PART_META_GUESS = 120;

/**
 * Split a file into parts whose v5 streams each fit in `maxStreamBytes`.
 *
 * The parts are slices of the (optionally compressed) file, so their txids
 * aren't known until they're inscribed; pass the plan and those txids to
 * {@link buildManifest} afterwards.
 */
export async function planMultipart(
  data: Uint8Array,
  options: MultipartPlanOptions,
): Promise<MultipartPlan> {
  const { maxStreamBytes, compress = "auto" } = options;
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes <= V5_FIXED_OVERHEAD + PART_META_GUESS) {
    throw new Error(`maxStreamBytes must be an integer above ${V5_FIXED_OVERHEAD + PART_META_GUESS}`);
  }
  if (data.length === 0) throw new Error("cannot split an empty file");

  let payload = data;
  let compression: MultipartCompression = "none";
  if (compress !== false) {
    const packed = await rawDeflate(data);
    if (compress === true || packed.length < data.length) {
      payload = packed;
      compression = "deflate-raw";
    }
  }

  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.length) {
    // The deflated metadata varies by a few bytes with the part's bpub id, so
    // shrink by however much the stream overshot until it fits.
    let length = Math.min(payload.length - offset, maxStreamBytes - V5_FIXED_OVERHEAD - PART_META_GUESS);
    for (;;) {
      const slice = payload.subarray(offset, offset + length);
      const stream = await buildStreamV5(slice, { mime: MULTIPART_PART_MIME });
      const over = stream.length - maxStreamBytes;
      if (over <= 0) {
        parts.push(slice.slice());
        break;
      }
      length -= over;
    }
    offset += length;
  }

  return {
    size: data.length,
    sha256: await sha256(data),
    bpubId: await computeBpubV5Id(data),
    compression,
    parts,
  };
}

/** Pair a plan with the txids its parts were inscribed under, in order. */
export function buildManifest(
  plan: MultipartPlan,
  partTxids: readonly string[],
  fields: ManifestFields = {},
): BpubManifest {
  if (partTxids.length !== plan.parts.length) {
    throw new Error(`expected ${plan.parts.length} part txids, got ${partTxids.length}`);
  }
  const manifest: BpubManifest = {
    version: MULTIPART_MANIFEST_VERSION,
    size: plan.size,
    sha256: plan.sha256,
    compression: plan.compression,
    parts: partTxids.map(normalizeTxid),
  };
  if (fields.mime) manifest.mime = fields.mime;
  if (fields.filename) manifest.filename = fields.filename;
  return manifest;
}

/**
 * Serialize a manifest to the bytes to inscribe:
 * `buildInscription(bytes, { mime: MULTIPART_MANIFEST_MIME, compress: true })`.
 */
export function encodeManifest(manifest: BpubManifest): Uint8Array {
  // Key order is fixed so the same manifest always encodes to the same bytes.
  const json: Record<string, unknown> = { bpub_manifest: manifest.version };
  if (manifest.mime) json["mime"] = manifest.mime;
  if (manifest.filename) json["filename"] = manifest.filename;
  json["size"] = manifest.size;
  json["sha256"] = bytesToHex(manifest.sha256);
  json["compression"] = manifest.compression;
  json["parts"] = manifest.parts;
  return utf8ToBytes(JSON.stringify(json));
}

/** Parse and validate manifest bytes (the content of a manifest inscription). */
export function parseManifest(content: Uint8Array): BpubManifest {
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(content));
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  if (!isRecord(json)) throw new Error("manifest is not a JSON object");

  const version = json["bpub_manifest"];
  if (version !== MULTIPART_MANIFEST_VERSION) {
    throw new Error(`unsupported manifest version: ${String(version)}`);
  }
  const compression = json["compression"];
  if (compression !== "none" && compression !== "deflate-raw") {
    throw new Error(`unsupported manifest compression: ${String(compression)}`);
  }
  const rawParts = json["parts"];
  if (!Array.isArray(rawParts) || rawParts.length === 0) {
    throw new Error("manifest has no parts");
  }

  const manifest: BpubManifest = {
    version,
    size: readSize(json["size"], "size"),
    sha256: readSha256(json["sha256"], "sha256"),
    compression,
    parts: rawParts.map((txid, index) => {
      if (typeof txid !== "string" || !/^[0-9a-f]{64}$/i.test(txid)) {
        throw new Error(`manifest part ${index} is not a txid`);
      }
      return txid.toLowerCase();
    }),
  };
  const mime = json["mime"];
  if (typeof mime === "string" && mime) manifest.mime = mime;
  const filename = json["filename"];
  if (typeof filename === "string" && filename) manifest.filename = filename;
  return manifest;
}

/**
 * Reassemble a multipart file from its parts' contents, in manifest order.
 *
 * Checks the result against the manifest's size and SHA-256.
 */
export async function assembleMultipart(
  manifest: BpubManifest,
  partContents: readonly Uint8Array[],
): Promise<Uint8Array> {
  if (partContents.length !== manifest.parts.length) {
    throw new Error(`expected ${manifest.parts.length} parts, got ${partContents.length}`);
  }
  const joined = concatBytes(...partContents);
  const content = manifest.compression === "deflate-raw" ? await rawInflate(joined) : joined;
  if (content.length !== manifest.size) {
    throw new Error(`reassembled file is ${content.length} bytes; the manifest says ${manifest.size}`);
  }
  if (!bytesEqual(await sha256(content), manifest.sha256)) {
    throw new Error("SHA-256 mismatch in the reassembled file");
  }
  return content;
}

/**
 * Metadata for the reassembled file, shaped like a single v5 inscription's,
 * so code that displays or moderates by {@link BpubMeta} works unchanged.
 */
export async function manifestFileMeta(manifest: BpubManifest): Promise<BpubMeta> {
  const meta: BpubMeta = {
    bpubVersion: 5,
    size: manifest.size,
    sha: manifest.sha256,
    bpubId: await sha256(
      concatBytes(utf8ToBytes("BPUB5"), manifest.sha256, uintToBytesBE(manifest.size, 8)),
    ),
  };
  if (manifest.mime) meta.mime = manifest.mime;
  if (manifest.filename) meta.filename = manifest.filename;
  return meta;
}

function normalizeTxid(txid: string): string {
  const clean = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error(`not a txid: ${txid}`);
  return clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSize(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`manifest ${field} must be a positive integer`);
  }
  return value;
}

function readSha256(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`manifest ${field} must be a 64-character hex SHA-256`);
  }
  return hexToBytes(value);
}

