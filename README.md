# bpub

A TypeScript port of the [`bpub`](https://github.com/djkazic/bpub) Python library.

BPUB embeds arbitrary data in Bitcoin by encoding it into **fake compressed
secp256k1 pubkeys** held inside 1-of-N P2WSH multisig redeem scripts. Each
pubkey carries 31 bytes of payload plus a ground nonce; the data is revealed
when the multisig outputs are spent, because the redeem scripts land in the
witness.

This port covers the data format (v3.5, v4 and v5 streams), the script and
transaction plumbing needed to read inscriptions back off-chain, and the pure
parts of the encode side.

- **Zero runtime dependencies.**
- **Runs in Node (>= 22) and modern browsers**, unbundled: hashing uses Web
  Crypto, DEFLATE uses Compression Streams, curve arithmetic uses `BigInt`.
- Verified against a real mainnet inscription (see [Tests](#tests)).

## Install

```sh
npm install bitfiles-bpub
```

<details>
<summary>Developing this repo</summary>

```sh
npm install   # dev dependencies only
npm run build # emits dist/
npm test
```

</details>

## Extract a file from a reveal transaction

By txid, letting the library fetch the transaction:

```ts
import { recoverFromTxid } from "bitfiles-bpub";

const { meta, content, source } = await recoverFromTxid(
  "c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e",
);
```

Or from raw hex you already have:

```ts
import { recoverFromRawTransaction, bytesToHex } from "bitfiles-bpub";

const { meta, content, controlPubkey } = await recoverFromRawTransaction(rawTxHex);

console.log(meta.filename);          // "luke.jpg"
console.log(meta.mime);              // "image/jpeg"
console.log(meta.size);              // 11276
console.log(bytesToHex(meta.sha));   // committed sha256, already verified
console.log(content);                // Uint8Array of the original file
```

`recoverFromRawTransaction` auto-detects the control pubkey and fails if the
inputs disagree; pass `{ controlPubkey }` (bytes or hex) to pin it. The decoder
verifies the committed length **and** SHA-256 before returning, so a successful
call means the bytes are intact.

`resolveRawTransaction` accepts **either** form, so UIs need only one input:

```ts
import { resolveRawTransaction, recoverFromRawTransaction } from "bitfiles-bpub";

const { hex, source } = await resolveRawTransaction(userInput); // txid or raw hex
const { meta, content } = await recoverFromRawTransaction(hex);
```

`resolveRawTransaction` and `recoverFromTxid` accept `{ chain }` (`"btc"` or
`"btcb2"`, defaulting to `"btcb2"`) to pick which chain to fetch a txid from.

In a browser, hand the result straight to a `Blob`:

```ts
const url = URL.createObjectURL(new Blob([content], { type: meta.mime }));
```

Runnable examples:

- `examples/extract.mjs` — Node CLI, taking a txid, a raw hex string, or a file:

  ```sh
  node examples/extract.mjs c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e
  node examples/extract.mjs --chain=btc c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e
  node examples/extract.mjs data/transaction.txt out.jpg
  ```

- `examples/index.html` — browser viewer with a chain dropdown (`btcb2` by
  default) and a single input that accepts a **txid or raw transaction
  hex**. Serve the repo root and open `/examples/index.html`; it autoloads
  the sample txid on `btcb2` and renders the image.

  The textbox and chain selection are mirrored into the URL, so any view is
  shareable:

  ```
  examples/index.html#btcb2/c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e
  examples/index.html#btc/0200000000011af0651569…          (a full raw transaction)
  examples/index.html?chain=btc&txid=c6c37101…              (migrated into the hash on load)
  ```

  The value lives in the **hash fragment**, not the query string: a raw
  transaction is tens of kilobytes, which exceeds the request line most
  servers accept, and the hash is never sent to the server. A hash without a
  recognized `btc/`/`btcb2/` prefix is a legacy link and defaults to
  `btcb2` (txids and raw hex never contain a slash, so this split is
  unambiguous). Edits use `replaceState`, so typing does not fill the back
  button, while opening a link, changing the dropdown, changing the hash, or
  pressing Back loads and extracts that transaction. A txid gives a short,
  chat-friendly link; pasted raw hex gives a ~33 kB URL that works but may be
  truncated by some clients. "Copy link" copies the current URL.

- `examples/cors-proxy-worker.js` — the self-hosted Cloudflare Worker referenced
  above, for fetching `"btcb2"` txids in a browser (see "Chains, sources, and
  CORS"). Deploy instructions are in the file's header comment.

## Encode a file

```ts
import { buildInscription, buildFundingTransaction } from "bitfiles-bpub";

// Redeem scripts + P2WSH scriptPubKeys, ready to fund however you like.
const inscription = await buildInscription(fileBytes, {
  mime: "image/jpeg",
  filename: "cat.jpg",
  compress: true,
  controlPubkey, // 33 bytes; you must hold the private key
});

// Or an unsigned single-input funding transaction (v5 requires an owner address).
const funding = await buildFundingTransaction({
  data: fileBytes,
  mime: "image/jpeg",
  filename: "cat.jpg",
  compress: true,
  controlPubkey,
  utxo: { txid, vout: 0, valueSats: 200_000 },
  feerate: 5,
  changeAddress: "bc1q…",
  ownerAddress: "bc1q…",
});
```

## API

| Area | Exports |
| --- | --- |
| Recovery | `recoverFromRawTransaction`, `recoverFromTransaction`, `recoverFromTxid`, `decodeOwnerTransfer` |
| Fetching | `fetchRawTransaction`, `resolveRawTransaction`, `recoverFromTxid`, `isTxid`, `isRawTransactionHex`, `isChain`, `CHAIN_SOURCES`, `DEFAULT_CHAIN` |
| Streams | `buildStreamV35`, `buildStreamV4`, `buildStreamV5`, `decodeStream`, `computeBpubV5Id`, `xorObfuscate` |
| Pubkey coding | `encodeStreamToPubkeys`, `decodePubkeysToStream`, `chunkDataPubkeys` |
| Scripts | `buildMultisigScript`, `parseBpubMultisigScript`, `buildOwnerRedeemScript`, `decodeOwnerRedeemScript`, `p2wshScriptPubKey`, `p2wpkhScriptPubKey`, `parseScript`, `pushData`, `smallIntFromOp` |
| Addresses | `addressToScriptPubKey`, `scriptPubKeyToAddress`, `ownerH160FromAddress`, `addressFromOwnerH160`, `bech32Encode`, `bech32Decode`, `encodeSegwitAddress`, `decodeSegwitAddress` |
| Transactions | `deserializeTransaction`, `serializeTransaction`, `transactionId`, `prevTxidHex`, `txidToBytes`, `encodeVarInt` |
| Encoding | `buildInscription`, `buildFundingTransaction` |
| Fees | `estimateFee`, `estimateFeeFunding`, `estimateFeeReveal`, `estimateFeeOwnerTransfer` |
| Primitives | `sha256`, `sha256d`, `hash160`, `ripemd160`, `rawDeflate`, `rawInflate`, `zlibDeflate`, `zlibInflate`, `modPow`, `sqrtModP`, `isQuadraticResidue`, `liftX` |

Everything speaks `Uint8Array`, never Node `Buffer`. Functions that hash or
compress are `async`, because Web Crypto and Compression Streams are.

### Mapping from the Python library

| `bpub.py` | here |
| --- | --- |
| `txrecover` | `recoverFromRawTransaction`, `recoverFromTxid` |
| `decodetransfer` | `decodeOwnerTransfer` |
| `encode` / `decode` | `buildStreamV5` / `decodeStream` |
| `txbuild` | `buildFundingTransaction` |
| `encode_stream_to_pubkeys` | `encodeStreamToPubkeys` |
| `decode_pubkeys_to_stream` | `decodePubkeysToStream` |
| `build_multisig_script` | `buildMultisigScript` |
| `build_owner_redeem_script` | `buildOwnerRedeemScript` |
| `owner_h160_from_address` | `ownerH160FromAddress` |
| `bech32_to_scriptpubkey` | `addressToScriptPubKey` |
| `meta["bpub_version"]`, `meta["bpub_id"]` | `meta.bpubVersion`, `meta.bpubId` (camelCase) |

Deliberately **not** ported: PSBT construction and signing (`fundpsbt`,
`revealpsbt`, `signreveal`, `ownertransferpsbt`), the node RPC indexer, and the
interactive wizard. Those need a wallet and a Bitcoin node, so they belong in
the upstream CLI rather than in a library that also runs in a browser. Use
`buildInscription` to get the scripts and drive signing with your own tooling.

### Known differences from upstream

- **Compressed streams are not byte-identical.** Python uses `zlib` at level 9;
  Compression Streams expose no level knob. Both emit valid raw DEFLATE and
  decode to the same bytes, and the committed SHA-256 and `bpub_id` are taken
  over the *uncompressed* content, so interoperability is unaffected.
- **v3.5 content is returned as stored.** Like upstream, `decodeStream` does not
  inflate legacy v3.5 streams; the TLV header commits to the sha256 of the
  stored bytes, and there is no flag recording whether they were compressed.
- `liftX` folds upstream's `is_quadratic_residue` + `sqrt_mod_p` pair into one
  modular exponentiation. It selects exactly the same nonces (verified against
  on-chain pubkeys in the tests).

## Tests

```sh
npm test
```

The suite runs against the real mainnet inscription in `data/`
([tx `c6c37101…bbf6197e`](https://mempool.guide/tx/c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e)),
and asserts more than "it didn't throw":

- the recovered bytes are **byte-identical to `data/luke.jpg`**, with the
  metadata (`luke.jpg`, `image/jpeg`, 11276 bytes) and `bpub_id` matching;
- re-encoding the recovered stream reproduces **all 364 on-chain data pubkeys
  exactly**, which pins down the nonce grinding and curve arithmetic;
- rebuilt redeem scripts match the on-chain witness scripts byte for byte;
- the parsed transaction re-serialises to the input hex and hashes to the
  published txid;
- RIPEMD-160 and BIP-173/350 reference vectors;
- txid/raw-hex classification and per-chain fetching against a stubbed
  `fetch`, including that a failure on one chain never falls back to the
  other chain's explorer, and that `{ fetchText }` fully replaces the
  default transport — used, then bypassed, then validated, then its errors
  checked for the right (and *missing*) hints (the suite makes no network
  calls; `BPUB_LIVE=1 npm test` adds a live fetch from the default chain,
  btcb2/mempool.guide);
- round-trips for v3.5 / v4 / v5 streams, and a funding transaction spent by a
  synthetic reveal transaction and read back.

Browser support was checked by loading `examples/index.html` in Chrome from
the built `dist/`, on both chains. On `btcb2` (default) with
`CORS_PROXY_WORKER_URL` unset (the shipped default), the sample txid
correctly fails with a CORS-specific error naming `mempool.guide`, and no
uncaught exception; with it pointed at a server implementing
`cors-proxy-worker.js`'s exact contract (verified with a local stand-in,
since deploying to Cloudflare requires an account only the maintainer has),
the same txid renders the 504×752 JPEG, and the recovered SHA-256 matches
every other extraction in this project — proving the proxy hop doesn't
corrupt the bytes. Simulating the worker going down mid-session produced a
clean "Failed to fetch" error, not a crash. The pasted-hex path (no network
call at all) remains available as a proxy-free fallback regardless. On
`btc`, the same txid fetches directly from mempool.space (CORS-enabled, no
proxy needed) in ~4 ms, confirming the chain dropdown reaches the right
explorer and skips the proxy when it isn't needed. URL syncing was checked
too — cold-loading a
`#btcb2/<txid>` link, a `#btc/<txid>` link, a `#<raw hex>` link (legacy, no
chain prefix, defaults to btcb2), and a `?chain=btc&txid=` link all extract
with the dropdown reflecting the URL's chain; changing the dropdown updates
the hash and re-extracts; typing updates the hash without growing
`history.length`; and Back restores the previous chain and transaction
together.

## License

MIT
