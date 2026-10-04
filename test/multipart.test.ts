import assert from "node:assert/strict";
import test from "node:test";

import {
  MULTIPART_MANIFEST_MIME,
  MULTIPART_PART_MIME,
  assembleMultipart,
  buildInscription,
  buildManifest,
  buildStreamV5,
  bytesToHex,
  computeBpubV5Id,
  encodeManifest,
  hexToBytes,
  manifestFileMeta,
  parseManifest,
  planMultipart,
  recoverMultipartFromTxid,
  serializeTransaction,
  transactionId,
  utf8ToBytes,
  type Transaction,
} from "../src/index.ts";

const CONTROL_PUBKEY = hexToBytes(
  "0388a5c118e856a90cf025cef167c00c224e96e2184229e450b6f59cd60dc2dda9",
);

/** Deterministic incompressible bytes (xorshift32). */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const text = utf8ToBytes("the quick brown fox jumps over the lazy dog\n".repeat(2_000));

/** A reveal transaction spending one fake output per redeem script, as the library tests do. */
async function revealFor(data: Uint8Array, mime: string, compress: boolean, salt: number) {
  const inscription = await buildInscription(data, { mime, compress, controlPubkey: CONTROL_PUBKEY });
  const tx: Transaction = {
    version: 2,
    inputs: inscription.redeemScripts.map((redeemScript, i) => ({
      prevTxid: new Uint8Array(32).fill(salt),
      prevIndex: i,
      scriptSig: new Uint8Array(0),
      sequence: 0xffffffff,
      witness: [new Uint8Array(0), new Uint8Array(71).fill(0x30), redeemScript],
    })),
    outputs: [{ value: 1000, scriptPubKey: new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]) }],
    lockTime: 0,
    hasWitness: true,
  };
  return { txid: await transactionId(tx), hex: bytesToHex(serializeTransaction(tx)) };
}

/** Inscribe a file as parts + manifest; returns the manifest txid and a fetch stub serving every transaction. */
async function inscribeMultipart(data: Uint8Array, maxStreamBytes: number) {
  const plan = await planMultipart(data, { maxStreamBytes });
  const served = new Map<string, string>();
  const partTxids: string[] = [];
  for (const [index, part] of plan.parts.entries()) {
    const { txid, hex } = await revealFor(part, MULTIPART_PART_MIME, false, index + 1);
    served.set(txid, hex);
    partTxids.push(txid);
  }
  const manifest = buildManifest(plan, partTxids, { mime: "application/octet-stream", filename: "big.bin" });
  const { txid, hex } = await revealFor(encodeManifest(manifest), MULTIPART_MANIFEST_MIME, true, 0xee);
  served.set(txid, hex);

  const fetchImpl = (async (input: string | URL | Request) => {
    const match = /\/api\/tx\/([0-9a-f]{64})\/hex$/.exec(String(input));
    const body = match ? served.get(match[1]!) : undefined;
    return new Response(body ?? "not found", { status: body ? 200 : 404 });
  }) as unknown as typeof globalThis.fetch;
  return { plan, manifest, manifestTxid: txid, fetchImpl };
}

test("planMultipart keeps every part stream within the limit", async () => {
  const cases = [
    { data: noise(20_000), compress: "auto" as const },
    { data: noise(20_000), compress: true },
    { data: text, compress: false },
  ];
  for (const { data, compress } of cases) {
    const plan = await planMultipart(data, { maxStreamBytes: 1_500, compress });
    assert.ok(plan.parts.length > 1);
    for (const part of plan.parts) {
      const stream = await buildStreamV5(part, { mime: MULTIPART_PART_MIME });
      assert.ok(stream.length <= 1_500, `stream is ${stream.length} bytes`);
    }
  }
});

test("planMultipart compresses only when it helps, unless told otherwise", async () => {
  assert.equal((await planMultipart(text, { maxStreamBytes: 4_000 })).compression, "deflate-raw");
  assert.equal((await planMultipart(noise(5_000), { maxStreamBytes: 4_000 })).compression, "none");
  assert.equal((await planMultipart(text, { maxStreamBytes: 4_000, compress: false })).compression, "none");
  assert.equal(
    (await planMultipart(noise(5_000), { maxStreamBytes: 4_000, compress: true })).compression,
    "deflate-raw",
  );
});

test("a manifest round-trips and reassembles the file", async () => {
  for (const data of [noise(20_000), text]) {
    const plan = await planMultipart(data, { maxStreamBytes: 1_500 });
    const txids = plan.parts.map((_, i) => i.toString(16).padStart(64, "0"));
    const manifest = parseManifest(encodeManifest(buildManifest(plan, txids, { mime: "text/plain" })));
    assert.equal(manifest.mime, "text/plain");
    assert.deepEqual(manifest.parts, txids);
    const content = await assembleMultipart(manifest, plan.parts);
    assert.deepEqual(content, data);
  }
});

test("the reassembled file keeps the bpub id it would have as one inscription", async () => {
  const plan = await planMultipart(text, { maxStreamBytes: 1_500 });
  const manifest = buildManifest(plan, plan.parts.map(() => "ab".repeat(32)));
  const meta = await manifestFileMeta(manifest);
  const expected = bytesToHex(await computeBpubV5Id(text));
  assert.equal(bytesToHex(meta.bpubId!), expected);
  assert.equal(bytesToHex(plan.bpubId), expected);
  assert.equal(meta.size, text.length);
});

test("assembleMultipart rejects missing or reordered parts", async () => {
  const plan = await planMultipart(noise(5_000), { maxStreamBytes: 1_500 });
  const manifest = buildManifest(plan, plan.parts.map(() => "cd".repeat(32)));
  const parts = plan.parts;

  await assert.rejects(assembleMultipart(manifest, parts.slice(1)), /expected \d+ parts/);
  await assert.rejects(assembleMultipart(manifest, [parts[1]!, parts[0]!, ...parts.slice(2)]), /SHA-256 mismatch/);
});

test("parseManifest rejects malformed manifests", () => {
  const valid = {
    bpub_manifest: 1,
    size: 3,
    sha256: "00".repeat(32),
    compression: "none",
    parts: ["11".repeat(32)],
  };
  const parse = (value: unknown) => parseManifest(utf8ToBytes(JSON.stringify(value)));
  assert.doesNotThrow(() => parse(valid));
  assert.throws(() => parseManifest(utf8ToBytes("{")), /not valid JSON/);
  assert.throws(() => parse({ ...valid, bpub_manifest: 2 }), /unsupported manifest version/);
  assert.throws(() => parse({ ...valid, compression: "zstd" }), /unsupported manifest compression/);
  assert.throws(() => parse({ ...valid, parts: [] }), /no parts/);
  assert.throws(() => parse({ ...valid, size: 0 }), /size must be/);
  assert.throws(() => parse({ ...valid, sha256: "zz" }), /sha256 must be/);
  assert.throws(() => parse({ ...valid, parts: ["nope"] }), /not a txid/);
});

test("buildManifest needs one txid per part", async () => {
  const plan = await planMultipart(noise(5_000), { maxStreamBytes: 1_500 });
  assert.throws(() => buildManifest(plan, ["ab".repeat(32)]), /expected \d+ part txids/);
});

test("recoverMultipartFromTxid fetches the parts and reassembles the file", async () => {
  const data = noise(12_000, 7);
  const { manifestTxid, fetchImpl, plan } = await inscribeMultipart(data, 2_000);
  const result = await recoverMultipartFromTxid(manifestTxid, { fetchImpl, concurrency: 3 });
  assert.deepEqual(result.content, data);
  assert.equal(result.txid, manifestTxid);
  assert.equal(result.meta.filename, "big.bin");
  assert.equal(result.meta.mime, "application/octet-stream");
  assert.equal(result.manifest.parts.length, plan.parts.length);
});

test("recoverMultipartFromTxid rejects inscriptions that aren't manifests", async () => {
  const { txid, hex } = await revealFor(utf8ToBytes("hello"), "text/plain", false, 5);
  const fetchImpl = (async () => new Response(hex)) as unknown as typeof globalThis.fetch;
  await assert.rejects(recoverMultipartFromTxid(txid, { fetchImpl }), /isn't a multipart manifest/);
});
