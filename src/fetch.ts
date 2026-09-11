/**
 * Fetching raw transactions by txid from mempool/esplora-compatible APIs.
 *
 * This is the only part of the library that touches the network. It uses the
 * global `fetch`, so it works in browsers and in Node >= 18; inject
 * `fetchImpl` to stub it.
 */

import { recoverFromRawTransaction } from "./recover.ts";
import type { RecoverOptions, RecoverResult } from "./recover.ts";

/**
 * bpub content exists on two chains that fork from shared Bitcoin history:
 * mainnet Bitcoin (`"btc"`) and Bitcoin-blake2b (`"btcb2"`). A txid existing
 * on one chain says nothing about its content on the other in general — the
 * sample transaction in `data/` is a concrete example: it exists on both
 * explorers below, but at different block heights (963343 on btcb2, 964731
 * on btc), which is proof they are independent chains, not mirrors of one
 * another. Each chain therefore has exactly ONE source, and
 * {@link fetchRawTransaction} never falls back across chains — a failure on
 * one chain is never silently retried against the other.
 */
export type Chain = "btc" | "btcb2";

/** The one authoritative source per chain. */
export const CHAIN_SOURCES: Readonly<Record<Chain, string>> = {
  btc: "https://mempool.space",
  btcb2: "https://mempool.guide",
};

/** Chain used when none is specified. */
export const DEFAULT_CHAIN: Chain = "btcb2";

/** True for a recognized chain identifier (`"btc"` or `"btcb2"`). */
export function isChain(value: string): value is Chain {
  return value === "btc" || value === "btcb2";
}

/** True for a 64-character hex string. */
export function isTxid(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

/** True for something long enough to plausibly be a raw transaction in hex. */
export function isRawTransactionHex(value: string): boolean {
  const clean = value.trim();
  return clean.length > 64 && clean.length % 2 === 0 && /^[0-9a-f]+$/i.test(clean);
}

export interface FetchTransactionOptions {
  /** Which chain to fetch from. Defaults to {@link DEFAULT_CHAIN} (`"btcb2"`). */
  chain?: Chain;
  /** Override the resolved source URL for `chain` (tests, self-hosted mirrors). */
  source?: string;
  /**
   * Replace the default fetch-and-decode step entirely, given the direct API
   * URL that would otherwise be requested, resolving to the raw transaction
   * hex text.
   *
   * Use this to route around CORS in a browser (e.g. `mempool.guide`, the
   * `"btcb2"` source, sends no `Access-Control-Allow-Origin` header) via a
   * CORS proxy, without the library needing to know that proxy's URL scheme
   * or response shape (some return the raw body directly; others, like
   * `api.allorigins.win/get`, wrap it in JSON under a `contents` field — this
   * hook lets the caller handle either).
   */
  fetchText?: (url: string) => Promise<string>;
  /** Override the global `fetch` (for tests or custom headers). Ignored when `fetchText` is set. */
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface FetchedTransaction {
  txid: string;
  /** Raw transaction hex. */
  hex: string;
  /** Base URL that served the response. */
  source: string;
  /** Chain the transaction was fetched from. */
  chain: Chain;
}

/**
 * Fetch a raw transaction by txid from the single source for `chain`.
 *
 * There is no cross-chain fallback: a failure fetching from the `"btcb2"`
 * source is never retried against the `"btc"` source, or vice versa, because
 * the two chains are not interchangeable (see the module doc comment above).
 */
export async function fetchRawTransaction(
  txid: string,
  options: FetchTransactionOptions = {},
): Promise<FetchedTransaction> {
  const { chain = DEFAULT_CHAIN, fetchText, fetchImpl = globalThis.fetch, signal } = options;
  const clean = txid.trim().toLowerCase();
  if (!isTxid(clean)) {
    throw new Error(`not a txid: ${txid}`);
  }
  if (!isChain(chain)) {
    throw new Error(`unknown chain: ${chain} (expected "btc" or "btcb2")`);
  }
  if (!fetchText && typeof fetchImpl !== "function") {
    throw new Error("no fetch implementation available; pass options.fetchImpl");
  }

  const source = (options.source ?? CHAIN_SOURCES[chain]).replace(/\/+$/, "");
  const url = `${source}/api/tx/${clean}/hex`;

  const fail = (detail: string): never => {
    // The hint only applies to the default direct-fetch path: a caller who
    // supplied `fetchText` has presumably already worked around CORS, so a
    // failure there is proxy-specific, not "your browser blocked this".
    const corsHint =
      chain === "btcb2" && !fetchText
        ? "\n  mempool.guide does not send Access-Control-Allow-Origin, so this " +
          "request fails in browsers even when the transaction exists; paste " +
          "the raw transaction hex instead of a txid, or pass options.fetchText " +
          "to route through a CORS proxy."
        : "";
    throw new Error(
      `could not fetch ${clean} for chain "${chain}" from ${source}: ${detail}${corsHint}`,
    );
  };

  let body: string;
  if (fetchText) {
    try {
      body = (await fetchText(url)).trim();
    } catch (error) {
      fail((error as Error).message);
    }
  } else {
    let response: Response;
    try {
      response = await fetchImpl(url, signal ? { signal } : undefined);
    } catch (error) {
      fail((error as Error).message);
    }
    // `fail` always throws (return type `never`), so `response` is assigned
    // whenever control reaches here; TS's narrowing doesn't see that across
    // the try/catch boundary, hence the assertions.
    body = (await response!.text()).trim();
    if (!response!.ok) {
      fail(`HTTP ${response!.status} ${body.slice(0, 80)}`.trim());
    }
  }
  // `fail` always throws (return type `never`), so `body` is assigned
  // whenever control reaches here; see the note above the `body =
  // (await response!.text())` line for why TS needs the assertions.
  if (!isRawTransactionHex(body!)) {
    fail("response is not raw transaction hex");
  }
  return { txid: clean, hex: body!.toLowerCase(), source, chain };
}

export interface ResolvedTransaction {
  /** Raw transaction hex. */
  hex: string;
  /** The txid that was looked up, when the input was a txid. */
  txid?: string;
  /** Base URL that served the hex, or `null` when the input was already hex. */
  source: string | null;
  /** Chain fetched from, when the input was a txid (raw hex needs no chain). */
  chain?: Chain;
}

/**
 * Accept either a txid or a raw transaction hex string and return raw hex,
 * fetching it when needed.
 */
export async function resolveRawTransaction(
  input: string,
  options: FetchTransactionOptions = {},
): Promise<ResolvedTransaction> {
  const clean = input.trim().replace(/\s+/g, "");
  if (!clean) throw new Error("no transaction id or hex provided");

  if (isTxid(clean)) {
    const fetched = await fetchRawTransaction(clean, options);
    return { hex: fetched.hex, txid: fetched.txid, source: fetched.source, chain: fetched.chain };
  }
  if (isRawTransactionHex(clean)) {
    return { hex: clean.toLowerCase(), source: null };
  }
  throw new Error("input is neither a 64-character txid nor a raw transaction hex string");
}

/** Fetch a transaction by txid and recover the BPUB inscription it reveals. */
export async function recoverFromTxid(
  txid: string,
  options: FetchTransactionOptions & RecoverOptions = {},
): Promise<RecoverResult & { txid: string; source: string; chain: Chain }> {
  const fetched = await fetchRawTransaction(txid, options);
  const result = await recoverFromRawTransaction(fetched.hex, options);
  return { ...result, txid: fetched.txid, source: fetched.source, chain: fetched.chain };
}
