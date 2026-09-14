import assert from "node:assert/strict";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { pubECDSA, randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { p2pkh, Transaction as ScureTransaction } from "@scure/btc-signer";

import {
  addressFromOwnerH160,
  buildFundingTransaction,
  buildInscription,
  buildOwnerRedeemScript,
  decodeOwnerTransfer,
  hash160,
  ownerH160FromAddress,
  p2wpkhScriptPubKey,
  p2wshScriptPubKey,
  recoverFromTransaction,
  signFundingTransaction,
  signOwnerTransferTransaction,
  signRevealTransaction,
  utf8ToBytes,
} from "../src/index.ts";

const OWNER_ADDRESS = "bc1q6au5md4j677d98ug4kpgy03ggq63a5f694d94m";

test("signRevealTransaction produces a transaction recoverFromTransaction can decode", async () => {
  const controlPrivateKey = randomPrivateKeyBytes();
  const controlPubkey = pubECDSA(controlPrivateKey, true);

  const payload = utf8ToBytes("signed reveal round trip ".repeat(30));
  const inscription = await buildInscription(payload, {
    version: "v5",
    mime: "text/plain",
    filename: "signed.txt",
    compress: true,
    controlPubkey,
  });

  const inputs = inscription.redeemScripts.map((redeemScript, i) => ({
    txid: (i + 1).toString(16).padStart(64, "0"),
    vout: 0,
    valueSats: 10_000,
    redeemScript,
  }));

  const signed = await signRevealTransaction({
    inputs,
    destinationAddress: OWNER_ADDRESS,
    controlPrivateKey,
    feerate: 2,
  });

  assert.equal(signed.transaction.outputs.length, 1);
  assert.equal(signed.transaction.inputs.length, inputs.length);
  for (const input of signed.transaction.inputs) {
    assert.equal(input.witness.length, 3);
    assert.equal(input.witness[0]!.length, 0);
  }
  assert.match(signed.txid, /^[0-9a-f]{64}$/);
  assert.ok(signed.feeSats > 0);

  const recovered = await recoverFromTransaction(signed.transaction);
  assert.equal(recovered.meta.filename, "signed.txt");
  assert.equal(recovered.meta.mime, "text/plain");
  assert.deepEqual(recovered.content, payload);
});

test("signRevealTransaction rejects a control key that doesn't match the redeem scripts", async () => {
  const controlPrivateKey = randomPrivateKeyBytes();
  const controlPubkey = pubECDSA(controlPrivateKey, true);
  const wrongPrivateKey = randomPrivateKeyBytes();

  const inscription = await buildInscription(utf8ToBytes("x".repeat(50)), {
    version: "v4",
    controlPubkey,
  });

  await assert.rejects(
    signRevealTransaction({
      inputs: [
        {
          txid: "11".repeat(32),
          vout: 0,
          valueSats: 10_000,
          redeemScript: inscription.redeemScripts[0]!,
        },
      ],
      destinationAddress: OWNER_ADDRESS,
      controlPrivateKey: wrongPrivateKey,
      feerate: 2,
    }),
    /only matched 0 of 1/,
  );
});

test("signOwnerTransferTransaction produces a cryptographically valid, decodable transfer", async () => {
  const bpubId = new Uint8Array(32).fill(0x42);
  const ownerPrivateKey = randomPrivateKeyBytes();
  const ownerPubkey = pubECDSA(ownerPrivateKey, true);
  const ownerH160 = await hash160(ownerPubkey);
  const ownerAddress = addressFromOwnerH160(ownerH160);

  const redeemScript = buildOwnerRedeemScript(bpubId, ownerH160);
  const scriptPubKey = await p2wshScriptPubKey(redeemScript);

  const utxo = { txid: "22".repeat(32), vout: 0, valueSats: 10_000 };

  const signed = await signOwnerTransferTransaction({
    bpubId,
    ownerPrivateKey,
    utxo,
    newOwnerAddress: OWNER_ADDRESS,
    feerate: 2,
  });

  assert.equal(signed.transaction.inputs.length, 1);
  const witness = signed.transaction.inputs[0]!.witness;
  assert.equal(witness.length, 3);
  assert.deepEqual(witness[1], ownerPubkey);
  assert.deepEqual(witness[2], redeemScript);

  // Cryptographic check: the witness signature actually verifies against the
  // BIP-143 sighash and the owner's pubkey, not just structurally shaped right.
  const verifyTx = new ScureTransaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  verifyTx.addInput({
    txid: signed.transaction.inputs[0]!.prevTxid,
    index: signed.transaction.inputs[0]!.prevIndex,
    witnessUtxo: { amount: BigInt(utxo.valueSats), script: scriptPubKey },
  });
  verifyTx.addOutput({
    script: signed.transaction.outputs[0]!.scriptPubKey,
    amount: BigInt(signed.transaction.outputs[0]!.value),
  });
  const sighash = verifyTx.preimageWitnessV0(0, redeemScript, 1, BigInt(utxo.valueSats));
  const derSig = witness[0]!.subarray(0, -1); // strip trailing sighash-type byte
  assert.ok(secp256k1.verify(derSig, sighash, ownerPubkey, { format: "der", prehash: false }));

  const transfer = await decodeOwnerTransfer(signed.transaction);
  assert.deepEqual(transfer.bpubId, bpubId);
  assert.equal(transfer.ownerAddress, ownerAddress);

  const newOwnerH160 = ownerH160FromAddress(OWNER_ADDRESS);
  const expectedNewScriptPubKey = await p2wshScriptPubKey(
    buildOwnerRedeemScript(bpubId, newOwnerH160),
  );
  assert.deepEqual(signed.transaction.outputs[0]!.scriptPubKey, expectedNewScriptPubKey);
});

test("signFundingTransaction signs the single P2WPKH input of an unsigned funding transaction", async () => {
  const fundingPrivateKey = randomPrivateKeyBytes();
  const fundingPubkey = pubECDSA(fundingPrivateKey, true);
  const controlPubkey = pubECDSA(randomPrivateKeyBytes(), true);

  const utxo = { txid: "33".repeat(32), vout: 0, valueSats: 200_000 };
  const funding = await buildFundingTransaction({
    data: utf8ToBytes("fund and sign".repeat(20)),
    mime: "text/plain",
    filename: "fund.txt",
    compress: true,
    controlPubkey,
    utxo,
    feerate: 2,
    changeAddress: OWNER_ADDRESS,
    ownerAddress: OWNER_ADDRESS,
  });

  const signed = await signFundingTransaction({ funding, utxo, privateKey: fundingPrivateKey });

  assert.equal(signed.transaction.inputs.length, 1);
  const witness = signed.transaction.inputs[0]!.witness;
  assert.equal(witness.length, 2);
  assert.deepEqual(witness[1], fundingPubkey);
  assert.equal(signed.feeSats, funding.feeSats);
  assert.deepEqual(signed.transaction.outputs, funding.transaction.outputs);

  const spendScriptPubKey = p2wpkhScriptPubKey(await hash160(fundingPubkey));
  const verifyTx = new ScureTransaction();
  verifyTx.addInput({
    txid: signed.transaction.inputs[0]!.prevTxid,
    index: signed.transaction.inputs[0]!.prevIndex,
    witnessUtxo: { amount: BigInt(utxo.valueSats), script: spendScriptPubKey },
  });
  for (const output of signed.transaction.outputs) {
    verifyTx.addOutput({ script: output.scriptPubKey, amount: BigInt(output.value) });
  }
  // BIP-143 signs against the P2PKH-equivalent scriptCode, not the P2WPKH witness program.
  const scriptCode = p2pkh(fundingPubkey).script;
  const sighash = verifyTx.preimageWitnessV0(0, scriptCode, 1, BigInt(utxo.valueSats));
  const derSig = witness[0]!.subarray(0, -1);
  assert.ok(secp256k1.verify(derSig, sighash, fundingPubkey, { format: "der", prehash: false }));
});
