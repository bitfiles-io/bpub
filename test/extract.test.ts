import assert from "node:assert/strict";
import test from "node:test";

import {
  bytesToHex,
  buildMultisigScript,
  decodePubkeysToStream,
  decodeStream,
  deserializeTransaction,
  encodeStreamToPubkeys,
  recoverFromRawTransaction,
  serializeTransaction,
  sha256,
  transactionId,
} from "../src/index.ts";
import { readDataFile, readTransactionHex } from "./helpers.ts";

const rawTxHex = readTransactionHex();
const expectedImage = readDataFile("luke.jpg");

/** From the explorer link in data/transaction.txt. */
const EXPECTED_TXID = "c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e";
const EXPECTED_CONTROL_PUBKEY =
  "0388a5c118e856a90cf025cef167c00c224e96e2184229e450b6f59cd60dc2dda9";
const EXPECTED_BPUB_ID = "6f0d177f3af04ba8c36c9373e034c8bcfa5816dc85d09d5b2e6d0b34a28927ef";

test("extracts luke.jpg from the reveal transaction", async () => {
  const { meta, content, controlPubkey, inputs } = await recoverFromRawTransaction(rawTxHex);

  assert.equal(meta.bpubVersion, 5);
  assert.equal(meta.filename, "luke.jpg");
  assert.equal(meta.mime, "image/jpeg");
  assert.equal(meta.size, 11276);
  assert.equal(bytesToHex(meta.bpubId!), EXPECTED_BPUB_ID);
  assert.equal(bytesToHex(controlPubkey), EXPECTED_CONTROL_PUBKEY);

  assert.equal(inputs.length, 26);
  assert.ok(inputs.every((input) => input.dataPubkeys.length === 14));

  assert.deepEqual(content, expectedImage);
  // JPEG SOI / EOI markers, so a truncated decode cannot pass silently.
  assert.deepEqual([...content.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...content.subarray(-2)], [0xff, 0xd9]);
});

test("recovered content matches the SHA-256 committed in the header", async () => {
  const { meta, content } = await recoverFromRawTransaction(rawTxHex);
  assert.equal(bytesToHex(await sha256(content)), bytesToHex(meta.sha));
});

test("an explicit control pubkey selects the same data", async () => {
  const auto = await recoverFromRawTransaction(rawTxHex);
  const explicit = await recoverFromRawTransaction(rawTxHex, {
    controlPubkey: EXPECTED_CONTROL_PUBKEY,
  });
  assert.deepEqual(explicit.content, auto.content);
});

test("a wrong control pubkey finds no BPUB scripts", async () => {
  await assert.rejects(
    () =>
      recoverFromRawTransaction(rawTxHex, {
        controlPubkey: `02${"11".repeat(32)}`,
      }),
    /no BPUB multisig scripts found/,
  );
});

test("decodeStream accepts the raw padded stream directly", async () => {
  const { stream } = await recoverFromRawTransaction(rawTxHex);
  // The pubkey encoder zero-pads the final 31-byte chunk; the length prefix
  // must bound the body so the padding is ignored.
  assert.equal(stream.length % 31, 0);
  const { content } = await decodeStream(stream);
  assert.deepEqual(content, expectedImage);
});

test("re-encoding the recovered stream reproduces the on-chain pubkeys", async () => {
  const { stream, inputs } = await recoverFromRawTransaction(rawTxHex);
  const onChain = inputs.flatMap((input) => input.dataPubkeys);
  const reEncoded = encodeStreamToPubkeys(stream);

  assert.equal(reEncoded.length, onChain.length);
  for (let i = 0; i < onChain.length; i++) {
    assert.equal(bytesToHex(reEncoded[i]!), bytesToHex(onChain[i]!), `pubkey ${i} differs`);
  }
  assert.deepEqual(decodePubkeysToStream(reEncoded), stream);
});

test("rebuilt redeem scripts match the on-chain witness scripts", async () => {
  const tx = deserializeTransaction(rawTxHex);
  const { controlPubkey, inputs } = await recoverFromRawTransaction(rawTxHex);

  for (const { index, dataPubkeys } of inputs) {
    const witness = tx.inputs[index]!.witness;
    const onChainScript = witness[witness.length - 1]!;
    assert.equal(
      bytesToHex(buildMultisigScript(dataPubkeys, controlPubkey)),
      bytesToHex(onChainScript),
      `redeem script for input ${index} differs`,
    );
  }
});

test("transaction round-trips and hashes to the published txid", async () => {
  const tx = deserializeTransaction(rawTxHex);
  assert.equal(tx.version, 2);
  assert.equal(tx.hasWitness, true);
  assert.equal(tx.inputs.length, 26);
  assert.equal(tx.outputs.length, 1);
  assert.equal(bytesToHex(serializeTransaction(tx)), rawTxHex.toLowerCase());
  assert.equal(await transactionId(tx), EXPECTED_TXID);
});
