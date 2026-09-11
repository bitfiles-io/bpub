import assert from "node:assert/strict";
import test from "node:test";

import {
  addressFromOwnerH160,
  addressToScriptPubKey,
  buildFundingTransaction,
  buildInscription,
  buildMultisigScript,
  buildOwnerRedeemScript,
  buildStreamV35,
  buildStreamV4,
  buildStreamV5,
  bytesToHex,
  chunkDataPubkeys,
  computeBpubV5Id,
  decodeOwnerRedeemScript,
  decodeOwnerTransfer,
  decodePubkeysToStream,
  decodeStream,
  deserializeTransaction,
  encodeStreamToPubkeys,
  hash160,
  hexToBytes,
  isQuadraticResidue,
  liftX,
  ownerH160FromAddress,
  P,
  p2wshScriptPubKey,
  parseBpubMultisigScript,
  recoverFromTransaction,
  ripemd160,
  scriptPubKeyToAddress,
  serializeTransaction,
  utf8ToBytes,
  xorObfuscate,
  type Transaction,
} from "../src/index.ts";
import { readDataFile } from "./helpers.ts";

const image = readDataFile("luke.jpg");
const CONTROL_PUBKEY = hexToBytes(
  "0388a5c118e856a90cf025cef167c00c224e96e2184229e450b6f59cd60dc2dda9",
);
/** P2WPKH address of the single output of the real reveal transaction. */
const OWNER_ADDRESS = "bc1q6au5md4j677d98ug4kpgy03ggq63a5f694d94m";

test("ripemd160 matches the reference test vectors", () => {
  const vectors: [string, string][] = [
    ["", "9c1185a5c5e9fc54612808977ee8f548b2258d31"],
    ["a", "0bdc9d2d256b3ee9daae347be6f4dc835a467ffe"],
    ["abc", "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"],
    ["message digest", "5d0689ef49d2fae572b881b123a85ffa21595f36"],
    ["abcdefghijklmnopqrstuvwxyz", "f71c27109c692c1b56bbdceb5b9d2865b3708dbc"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "b0e20b6e3116640286ed3a87a5713079b21f5189",
    ],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(bytesToHex(ripemd160(utf8ToBytes(input))), expected, `ripemd160(${input})`);
  }
  // 1 million 'a' characters is the long-message vector; use 1000 blocks of 1000.
  assert.equal(
    bytesToHex(ripemd160(utf8ToBytes("a".repeat(1_000_000)))),
    "52783243c1697bdbe16d37f97f68f08325dc1528",
  );
});

test("hash160 matches a known pubkey hash", async () => {
  // Compressed pubkey from BIP-143's P2WPKH example.
  const pubkey = hexToBytes("025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357");
  assert.equal(bytesToHex(await hash160(pubkey)), "1d0f172a0ecb48aee1be1f2687d2963ae33f71a1");
});

test("xorObfuscate is symmetric and uses the published salt", () => {
  const data = utf8ToBytes("BPUB, plainly");
  assert.deepEqual(xorObfuscate(xorObfuscate(data)), data);
  assert.equal(bytesToHex(xorObfuscate(new Uint8Array(4))), "536a19a1");
});

test("curve helpers lift on-curve x-coordinates and reject others", () => {
  const gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  const gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

  const y = liftX(gx);
  assert.ok(y !== null, "the generator x must lie on the curve");
  // sqrt is only defined up to sign, so either root is correct.
  assert.ok(y === gy || y === P - gy, "recovered y must be +/- the generator y");
  assert.equal((y * y) % P, (gx * gx * gx + 7n) % P);

  assert.equal(isQuadraticResidue((gy * gy) % P), true);
  assert.equal(liftX(P), null, "x must be reduced mod p");
  assert.equal(liftX(P + 1n), null);

  // Roughly half of all x-coordinates lift; make sure both outcomes occur.
  let lifted = 0;
  for (let i = 0n; i < 40n; i++) if (liftX(i) !== null) lifted++;
  assert.ok(lifted > 5 && lifted < 35, `expected a mix of outcomes, got ${lifted}/40`);
});

test("pubkey encoding round-trips arbitrary byte lengths", () => {
  for (const length of [0, 1, 30, 31, 32, 62, 100, 1000]) {
    const payload = new Uint8Array(length);
    for (let i = 0; i < length; i++) payload[i] = (i * 7 + 11) & 0xff;

    const pubkeys = encodeStreamToPubkeys(payload);
    assert.equal(pubkeys.length, Math.ceil(length / 31));
    for (const pk of pubkeys) {
      assert.equal(pk.length, 33);
      assert.ok(pk[0] === 0x02 || pk[0] === 0x03, "prefix must be a valid SEC prefix");
      assert.notEqual(liftX(BigInt(`0x${bytesToHex(pk.subarray(1))}`)), null);
    }

    const decoded = decodePubkeysToStream(pubkeys);
    assert.deepEqual(decoded.subarray(0, length), payload);
    // Anything past the payload is zero padding.
    assert.ok(decoded.subarray(length).every((b) => b === 0));
  }
});

test("chunkDataPubkeys packs 14 data pubkeys per script", () => {
  const pubkeys = Array.from({ length: 30 }, () => new Uint8Array(33));
  const chunks = chunkDataPubkeys(pubkeys);
  assert.deepEqual(chunks.map((c) => c.length), [14, 14, 2]);
});

test("v5 stream round-trips with and without compression", async () => {
  for (const compress of [false, true]) {
    const stream = await buildStreamV5(image, {
      mime: "image/jpeg",
      filename: "luke.jpg",
      compress,
    });
    const { meta, content } = await decodeStream(stream);
    assert.equal(meta.bpubVersion, 5);
    assert.equal(meta.mime, "image/jpeg");
    assert.equal(meta.filename, "luke.jpg");
    assert.equal(meta.size, image.length);
    assert.deepEqual(content, image);
    assert.equal(bytesToHex(meta.bpubId!), bytesToHex(await computeBpubV5Id(image)));
  }
});

test("v4 stream round-trips and carries no bpub id", async () => {
  const stream = await buildStreamV4(image, { mime: "image/jpeg", compress: true });
  const { meta, content } = await decodeStream(stream);
  assert.equal(meta.bpubVersion, 4);
  assert.equal(meta.mime, "image/jpeg");
  assert.equal(meta.filename, undefined);
  assert.equal(meta.bpubId, undefined);
  assert.deepEqual(content, image);
});

test("legacy v3.5 stream round-trips", async () => {
  const stream = await buildStreamV35(image, { mime: "image/jpeg", filename: "luke.jpg" });
  assert.deepEqual([...stream.subarray(0, 5)], [0x42, 0x50, 0x55, 0x42, 0x01]);
  const { meta, content } = await decodeStream(stream);
  assert.equal(meta.bpubVersion, 1);
  assert.equal(meta.mime, "image/jpeg");
  assert.equal(meta.filename, "luke.jpg");
  assert.deepEqual(content, image);
});

test("decodeStream rejects a corrupted body", async () => {
  const stream = await buildStreamV5(image, { mime: "image/jpeg" });
  const corrupted = stream.slice();
  corrupted[corrupted.length - 1] ^= 0xff;
  await assert.rejects(() => decodeStream(corrupted), /SHA-256 mismatch/);

  await assert.rejects(() => decodeStream(stream.slice(0, 40)), /truncated/);
  await assert.rejects(() => decodeStream(new Uint8Array(0)), /empty BPUB payload/);
});

test("multisig scripts round-trip through the parser", () => {
  const dataPubkeys = encodeStreamToPubkeys(utf8ToBytes("x".repeat(100)));
  const script = buildMultisigScript(dataPubkeys, CONTROL_PUBKEY);
  const parsed = parseBpubMultisigScript(script);
  assert.ok(parsed);
  assert.equal(parsed.dataPubkeys.length, dataPubkeys.length);
  assert.equal(bytesToHex(parsed.controlPubkey), bytesToHex(CONTROL_PUBKEY));

  assert.equal(parseBpubMultisigScript(new Uint8Array([0x51, 0xae])), null);
  assert.equal(parseBpubMultisigScript(new Uint8Array(0)), null);
  assert.equal(parseBpubMultisigScript(hexToBytes("51210288")), null, "truncated push");
});

test("owner redeem scripts round-trip", () => {
  const bpubId = hexToBytes("6f0d177f3af04ba8c36c9373e034c8bcfa5816dc85d09d5b2e6d0b34a28927ef");
  const ownerH160 = ownerH160FromAddress(OWNER_ADDRESS);
  const script = buildOwnerRedeemScript(bpubId, ownerH160);
  const decoded = decodeOwnerRedeemScript(script);
  assert.equal(bytesToHex(decoded.bpubId), bytesToHex(bpubId));
  assert.equal(bytesToHex(decoded.ownerH160), bytesToHex(ownerH160));
  assert.equal(addressFromOwnerH160(decoded.ownerH160), OWNER_ADDRESS);

  assert.throws(() => decodeOwnerRedeemScript(new Uint8Array([0x51, 0xae])), /structure/);
});

test("bech32 address conversion matches the BIP-173 vectors", () => {
  const vectors: [string, string][] = [
    ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "0014751e76e8199196d454941c45d1b3a323f1433bd6"],
    [
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
      "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
    ],
    [
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ],
  ];
  for (const [address, scriptPubKey] of vectors) {
    assert.equal(bytesToHex(addressToScriptPubKey(address)), scriptPubKey, address);
    assert.equal(
      scriptPubKeyToAddress(hexToBytes(scriptPubKey)),
      address.toLowerCase(),
      scriptPubKey,
    );
  }

  assert.throws(() => addressToScriptPubKey("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"), /checksum/);
  assert.throws(
    () => ownerH160FromAddress("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"),
    /P2WPKH/,
  );
});

test("funding transaction commits to the inscription and can be revealed", async () => {
  const payload = utf8ToBytes("hello from a browser-friendly bpub port".repeat(20));
  const funding = await buildFundingTransaction({
    data: payload,
    mime: "text/plain",
    filename: "note.txt",
    compress: true,
    controlPubkey: CONTROL_PUBKEY,
    utxo: {
      txid: "c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e",
      vout: 0,
      valueSats: 200_000,
    },
    feerate: 2,
    changeAddress: OWNER_ADDRESS,
    ownerAddress: OWNER_ADDRESS,
  });

  const { inscription } = funding;
  assert.equal(inscription.version, "v5");
  assert.ok(inscription.bpubId);
  assert.equal(inscription.scriptPubKeys.length, inscription.redeemScripts.length);
  // data outputs + owner output + change output
  assert.equal(funding.transaction.outputs.length, inscription.scriptPubKeys.length + 2);
  assert.equal(
    bytesToHex(serializeTransaction(deserializeTransaction(funding.rawHex))),
    funding.rawHex,
  );
  for (const [i, redeemScript] of inscription.redeemScripts.entries()) {
    assert.equal(
      bytesToHex(await p2wshScriptPubKey(redeemScript)),
      bytesToHex(inscription.scriptPubKeys[i]!),
    );
  }

  // Spend every data output in a synthetic reveal transaction and read it back.
  const revealTx: Transaction = {
    version: 2,
    inputs: inscription.redeemScripts.map((redeemScript, i) => ({
      prevTxid: new Uint8Array(32).fill(i + 1),
      prevIndex: i,
      scriptSig: new Uint8Array(0),
      sequence: 0xffffffff,
      witness: [new Uint8Array(0), new Uint8Array(71).fill(0x30), redeemScript],
    })),
    outputs: [{ value: 1000, scriptPubKey: addressToScriptPubKey(OWNER_ADDRESS) }],
    lockTime: 0,
    hasWitness: true,
  };

  const recovered = await recoverFromTransaction(revealTx);
  assert.equal(recovered.meta.filename, "note.txt");
  assert.equal(recovered.meta.mime, "text/plain");
  assert.deepEqual(recovered.content, payload);
  assert.equal(bytesToHex(recovered.meta.bpubId!), bytesToHex(inscription.bpubId!));
});

test("owner transfer transactions expose ownership details", async () => {
  const bpubId = hexToBytes("6f0d177f3af04ba8c36c9373e034c8bcfa5816dc85d09d5b2e6d0b34a28927ef");
  const ownerH160 = ownerH160FromAddress(OWNER_ADDRESS);
  const redeemScript = buildOwnerRedeemScript(bpubId, ownerH160);
  const ownerScriptPubKey = await p2wshScriptPubKey(redeemScript);

  const tx: Transaction = {
    version: 2,
    inputs: [
      {
        prevTxid: new Uint8Array(32).fill(9),
        prevIndex: 0,
        scriptSig: new Uint8Array(0),
        sequence: 0xffffffff,
        witness: [new Uint8Array(71).fill(0x30), new Uint8Array(33).fill(0x02), redeemScript],
      },
    ],
    outputs: [{ value: 10_000, scriptPubKey: ownerScriptPubKey }],
    lockTime: 0,
    hasWitness: true,
  };

  const transfer = await decodeOwnerTransfer(tx);
  assert.equal(bytesToHex(transfer.bpubId), bytesToHex(bpubId));
  assert.equal(transfer.ownerAddress, OWNER_ADDRESS);
  assert.deepEqual(transfer.ownerOutputs, [{ vout: 0, valueSats: 10_000 }]);
});
