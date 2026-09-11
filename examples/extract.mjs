#!/usr/bin/env node
// Extract a BPUB inscription from a reveal transaction.
//
//   node examples/extract.mjs [--chain=btc|btcb2] <txid | rawtx-file | rawtx-hex> [output-file]
//
//   node examples/extract.mjs c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e
//   node examples/extract.mjs --chain=btc c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e
//   node examples/extract.mjs data/transaction.txt out.jpg
//
// Run `npm run build` first, or swap the import for ../src/index.ts and run
// with a Node that strips types (>= 22.6).

import { readFile, writeFile } from "node:fs/promises";
import {
  bytesToHex,
  DEFAULT_CHAIN,
  isChain,
  isTxid,
  recoverFromRawTransaction,
  resolveRawTransaction,
} from "../dist/index.js";

const rawArgs = process.argv.slice(2);
const chainArg = rawArgs.find((a) => a.startsWith("--chain="));
const chain = chainArg ? chainArg.slice("--chain=".length) : DEFAULT_CHAIN;
const positional = rawArgs.filter((a) => !a.startsWith("--chain="));
const [target, output] = positional;

if (!target) {
  console.error(
    "usage: node examples/extract.mjs [--chain=btc|btcb2] <txid | rawtx-file | rawtx-hex> [output-file]",
  );
  process.exit(2);
}
if (!isChain(chain)) {
  console.error(`unknown chain: ${chain} (expected "btc" or "btcb2")`);
  process.exit(2);
}

/** Accept a txid, a raw hex string, or a file containing raw hex. */
async function readInput(value) {
  if (isTxid(value)) return value;
  const looksLikeHex = /^[0-9a-f\s]+$/i.test(value) && value.replace(/\s+/g, "").length > 64;
  if (looksLikeHex) return value;

  const text = await readFile(value, "utf8");
  const hex = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f]{400,}$/i.test(line));
  if (!hex) throw new Error(`no raw transaction hex found in ${value}`);
  return hex;
}

const resolved = await resolveRawTransaction(await readInput(target), { chain });
if (resolved.source) {
  console.error(`# fetched ${resolved.txid} from ${resolved.source} (chain=${resolved.chain})`);
}

const { meta, content, controlPubkey, inputs } = await recoverFromRawTransaction(resolved.hex);

console.error(`# recovered BPUB v${meta.bpubVersion} from ${inputs.length} inputs`);
console.error(`# filename=${meta.filename} mime=${meta.mime} size=${meta.size}`);
console.error(`# sha256=${bytesToHex(meta.sha)}`);
if (meta.bpubId) console.error(`# bpub_id=${bytesToHex(meta.bpubId)}`);
console.error(`# control_pubkey=${bytesToHex(controlPubkey)}`);

const destination = output ?? meta.filename ?? "bpub.bin";
await writeFile(destination, content);
console.error(`# wrote ${content.length} bytes to ${destination}`);
