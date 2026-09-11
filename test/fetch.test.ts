import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAIN_SOURCES,
  DEFAULT_CHAIN,
  fetchRawTransaction,
  isChain,
  isRawTransactionHex,
  isTxid,
  recoverFromTxid,
  resolveRawTransaction,
} from "../src/index.ts";
import { readDataFile, readTransactionHex } from "./helpers.ts";

const TXID = "c6c3710169c5d8516cb45a70d2278fdadb04f21c82840703238ae428bbf6197e";
const rawTxHex = readTransactionHex();
const expectedImage = readDataFile("luke.jpg");

/** A `fetch` stub that serves the sample transaction from chosen hosts only. */
function stubFetch(
  behaviour: Record<string, { status?: number; body?: string; throws?: string }>,
): { fetchImpl: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const host = new URL(url).origin;
    const entry = behaviour[host];
    if (!entry) throw new TypeError("Failed to fetch");
    if (entry.throws) throw new TypeError(entry.throws);
    return new Response(entry.body ?? "", { status: entry.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

test("isTxid and isRawTransactionHex classify inputs", () => {
  assert.equal(isTxid(TXID), true);
  assert.equal(isTxid(TXID.toUpperCase()), true);
  assert.equal(isTxid(` ${TXID} `), true);
  assert.equal(isTxid(TXID.slice(0, 63)), false);
  assert.equal(isTxid(`${TXID}00`), false);
  assert.equal(isTxid(`${TXID.slice(0, 63)}z`), false);

  assert.equal(isRawTransactionHex(rawTxHex), true);
  assert.equal(isRawTransactionHex(TXID), false, "a txid is not a raw transaction");
  assert.equal(isRawTransactionHex(`${rawTxHex}a`), false, "odd length");
});

test("CHAIN_SOURCES maps each chain to exactly one explorer, defaulting to btcb2", () => {
  assert.equal(CHAIN_SOURCES.btc, "https://mempool.space");
  assert.equal(CHAIN_SOURCES.btcb2, "https://mempool.guide");
  assert.equal(DEFAULT_CHAIN, "btcb2");
});

test("isChain validates chain identifiers", () => {
  assert.equal(isChain("btc"), true);
  assert.equal(isChain("btcb2"), true);
  assert.equal(isChain("BTC"), false);
  assert.equal(isChain("ethereum"), false);
  assert.equal(isChain(""), false);
});

test("fetchRawTransaction defaults to btcb2 (mempool.guide) when no chain is given", async () => {
  const { fetchImpl, calls } = stubFetch({ "https://mempool.guide": { body: `${rawTxHex}\n` } });
  const fetched = await fetchRawTransaction(TXID, { fetchImpl });
  assert.equal(fetched.chain, "btcb2");
  assert.equal(fetched.source, "https://mempool.guide");
  assert.equal(fetched.txid, TXID);
  assert.equal(fetched.hex, rawTxHex.toLowerCase());
  assert.deepEqual(calls, [`https://mempool.guide/api/tx/${TXID}/hex`]);
});

test("fetchRawTransaction fetches from mempool.space when chain is btc", async () => {
  const { fetchImpl, calls } = stubFetch({ "https://mempool.space": { body: rawTxHex } });
  const fetched = await fetchRawTransaction(TXID, { fetchImpl, chain: "btc" });
  assert.equal(fetched.chain, "btc");
  assert.equal(fetched.source, "https://mempool.space");
  assert.deepEqual(calls, [`https://mempool.space/api/tx/${TXID}/hex`]);
});

test("there is no fallback: a failing btcb2 source is not retried against btc", async () => {
  const { fetchImpl, calls } = stubFetch({
    "https://mempool.guide": { throws: "Failed to fetch" },
    "https://mempool.space": { body: rawTxHex }, // would succeed, must NOT be tried
  });
  await assert.rejects(() => fetchRawTransaction(TXID, { fetchImpl, chain: "btcb2" }));
  assert.equal(calls.length, 1, "exactly one request should be made, no fallback");
  assert.deepEqual(calls, [`https://mempool.guide/api/tx/${TXID}/hex`]);
});

test("a failed btcb2 fetch reports the chain, source, and a CORS hint", async () => {
  const { fetchImpl } = stubFetch({
    "https://mempool.guide": { status: 404, body: "Transaction not found" },
  });
  await assert.rejects(
    () => fetchRawTransaction(TXID, { fetchImpl, chain: "btcb2" }),
    (error: Error) => {
      assert.match(error.message, /chain "btcb2"/);
      assert.match(error.message, /mempool\.guide/);
      assert.match(error.message, /HTTP 404/);
      assert.match(error.message, /does not send Access-Control-Allow-Origin/);
      return true;
    },
  );
});

test("a failed btc fetch reports the chain and source without the btcb2 CORS hint", async () => {
  const { fetchImpl } = stubFetch({
    "https://mempool.space": { status: 404, body: "Transaction not found" },
  });
  await assert.rejects(
    () => fetchRawTransaction(TXID, { fetchImpl, chain: "btc" }),
    (error: Error) => {
      assert.match(error.message, /chain "btc"/);
      assert.match(error.message, /mempool\.space/);
      assert.match(error.message, /HTTP 404/);
      assert.doesNotMatch(error.message, /Access-Control-Allow-Origin/);
      return true;
    },
  );
});

test("fetchRawTransaction rejects an unknown chain", async () => {
  const { fetchImpl } = stubFetch({});
  await assert.rejects(
    () => fetchRawTransaction(TXID, { fetchImpl, chain: "dogecoin" as never }),
    /unknown chain/,
  );
});

test("fetchRawTransaction rejects anything that is not a txid", async () => {
  const { fetchImpl, calls } = stubFetch({});
  await assert.rejects(() => fetchRawTransaction(rawTxHex, { fetchImpl }), /not a txid/);
  await assert.rejects(() => fetchRawTransaction("", { fetchImpl }), /not a txid/);
  assert.equal(calls.length, 0, "no request should be made");
});

test("options.source overrides the chain's default explorer", async () => {
  const { fetchImpl, calls } = stubFetch({ "https://my-mempool.example": { body: rawTxHex } });
  const fetched = await fetchRawTransaction(TXID, {
    fetchImpl,
    chain: "btc",
    source: "https://my-mempool.example",
  });
  assert.equal(fetched.source, "https://my-mempool.example");
  assert.deepEqual(calls, [`https://my-mempool.example/api/tx/${TXID}/hex`]);
});

test("options.fetchText replaces the default fetch, receiving the direct API URL", async () => {
  const requestedUrls: string[] = [];
  const fetchText = async (url: string) => {
    requestedUrls.push(url);
    return `${rawTxHex}\n`; // real CORS proxies may add trailing whitespace
  };
  const fetched = await fetchRawTransaction(TXID, { chain: "btcb2", fetchText });
  assert.equal(fetched.source, "https://mempool.guide");
  assert.equal(fetched.hex, rawTxHex.toLowerCase());
  assert.deepEqual(requestedUrls, [`https://mempool.guide/api/tx/${TXID}/hex`]);
});

test("options.fetchText need not touch options.fetchImpl at all", async () => {
  // A fetchImpl that always throws must never be reached when fetchText is set.
  const fetchImpl = (async () => {
    throw new Error("fetchImpl should not have been called");
  }) as unknown as typeof globalThis.fetch;
  const fetched = await fetchRawTransaction(TXID, {
    chain: "btcb2",
    fetchImpl,
    fetchText: async () => rawTxHex,
  });
  assert.equal(fetched.hex, rawTxHex.toLowerCase());
});

test("a failing fetchText reports the chain and source, without the CORS hint", async () => {
  await assert.rejects(
    () =>
      fetchRawTransaction(TXID, {
        chain: "btcb2",
        fetchText: async () => {
          throw new Error("proxy HTTP 502");
        },
      }),
    (error: Error) => {
      assert.match(error.message, /chain "btcb2"/);
      assert.match(error.message, /mempool\.guide/);
      assert.match(error.message, /proxy HTTP 502/);
      assert.doesNotMatch(
        error.message,
        /Access-Control-Allow-Origin/,
        "the direct-fetch CORS hint should not appear when a custom transport was supplied",
      );
      return true;
    },
  );
});

test("fetchText output is still validated as raw transaction hex", async () => {
  await assert.rejects(
    () => fetchRawTransaction(TXID, { chain: "btcb2", fetchText: async () => "<html>oops</html>" }),
    /response is not raw transaction hex/,
  );
});

test("resolveRawTransaction threads chain through to fetchRawTransaction", async () => {
  const { fetchImpl, calls } = stubFetch({ "https://mempool.guide": { body: rawTxHex } });

  const fromTxid = await resolveRawTransaction(TXID, { fetchImpl });
  assert.equal(fromTxid.hex, rawTxHex.toLowerCase());
  assert.equal(fromTxid.txid, TXID);
  assert.equal(fromTxid.source, "https://mempool.guide");
  assert.equal(fromTxid.chain, "btcb2", "default chain when none is given");

  const fromHex = await resolveRawTransaction(rawTxHex, { fetchImpl, chain: "btc" });
  assert.equal(fromHex.hex, rawTxHex.toLowerCase());
  assert.equal(fromHex.source, null, "raw hex needs no network request");
  assert.equal(fromHex.txid, undefined);
  assert.equal(fromHex.chain, undefined, "no network call, no chain to report");
  assert.equal(calls.length, 1, "only the txid lookup should fetch");

  // Whitespace and newlines in a pasted hex blob are tolerated.
  const wrapped = rawTxHex.replace(/(.{64})/g, "$1\n");
  assert.equal((await resolveRawTransaction(wrapped, { fetchImpl })).hex, rawTxHex.toLowerCase());

  await assert.rejects(() => resolveRawTransaction("", { fetchImpl }), /no transaction id or hex/);
  await assert.rejects(() => resolveRawTransaction("not hex!", { fetchImpl }), /neither/);
});

test("recoverFromTxid fetches from the given chain and extracts in one call", async () => {
  const { fetchImpl } = stubFetch({ "https://mempool.guide": { body: rawTxHex } });
  const result = await recoverFromTxid(TXID, { fetchImpl });
  assert.equal(result.txid, TXID);
  assert.equal(result.chain, "btcb2");
  assert.equal(result.source, "https://mempool.guide");
  assert.equal(result.meta.filename, "luke.jpg");
  assert.deepEqual(result.content, expectedImage);
});

// Opt-in live check: BPUB_LIVE=1 npm test
test(
  "live: fetches the sample transaction from the default chain (btcb2/mempool.guide)",
  { skip: process.env["BPUB_LIVE"] !== "1" ? "set BPUB_LIVE=1 to enable" : false },
  async () => {
    const result = await recoverFromTxid(TXID);
    assert.equal(result.chain, "btcb2");
    assert.deepEqual(result.content, expectedImage);
    console.log(`# served by ${result.source} (${result.chain})`);
  },
);
