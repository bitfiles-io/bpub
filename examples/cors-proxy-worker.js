/**
 * A minimal CORS proxy for mempool.guide's tx-hex endpoint, meant to be
 * deployed as your own Cloudflare Worker (free tier: 100,000 requests/day,
 * no credit card).
 *
 * Why this exists: mempool.guide (the default "btcb2" chain source) sends no
 * Access-Control-Allow-Origin header, so browsers can't fetch it directly.
 * Free anonymous third-party CORS proxies (corsproxy.io, api.allorigins.win)
 * have both, at different times, stopped working reliably or started
 * requiring paid API keys — see README.md's "Chains, sources, and CORS"
 * section. Self-hosting removes that dependency entirely: it's still free,
 * but nobody else's policy change or outage can break it.
 *
 * The worker only relays the exact path shape bpub needs
 * (`/api/tx/<64-hex-char-txid>/hex`, GET only) — not an open relay for
 * arbitrary URLs — so it's safe to deploy publicly.
 *
 * Deploy (about 2 minutes, no CLI required):
 *   1. https://dash.cloudflare.com/ → sign up free if needed.
 *   2. Workers & Pages → Create → "Create Worker".
 *   3. Give it a name (e.g. "bpub-cors-proxy"), click "Deploy" to scaffold it.
 *   4. Click "Edit code" and replace the contents with this file. Deploy.
 *   5. Copy the resulting URL (https://<name>.<your-subdomain>.workers.dev).
 *   6. Paste it into `CORS_PROXY_WORKER_URL` near the top of the <script> in
 *      examples/index.html.
 *
 * (`wrangler deploy` works too, if you'd rather use the CLI: `npx wrangler
 * deploy examples/cors-proxy-worker.js --name bpub-cors-proxy --compatibility-date 2025-01-01`.)
 */

const UPSTREAM = "https://mempool.guide";
const ALLOWED_PATH = /^\/api\/tx\/[0-9a-f]{64}\/hex$/i;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (request.method !== "GET" || !ALLOWED_PATH.test(url.pathname)) {
      return new Response("not found: this proxy only relays /api/tx/<txid>/hex\n", {
        status: 404,
        headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + url.pathname, { headers: { accept: "text/plain" } });
    } catch (error) {
      return new Response(`upstream fetch failed: ${error.message}\n`, {
        status: 502,
        headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  },
};
