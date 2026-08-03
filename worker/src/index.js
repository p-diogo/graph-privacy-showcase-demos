/**
 * Attested-query proxy for the Graph Privacy Showcase verification page.
 *
 * WHY THIS EXISTS
 * A public page cannot carry a gateway API key, so the browser cannot query the
 * decentralized network directly. This Worker holds the key as a secret and
 * forwards a *very* narrow set of queries.
 *
 * WHY YOU DO NOT HAVE TO TRUST IT
 * Every gateway response carries an EIP-712 `graph-attestation` signed by the
 * serving indexer over the exact request and response bytes. The page verifies
 * that signature in the browser and resolves the signer to a staked allocation
 * on Arbitrum. So this proxy is untrusted by construction: if it altered a byte,
 * the attestation would stop verifying. That is the whole demonstration.
 *
 * WHY CACHING IS SAFE, AND WHY IT MATTERS
 * The key is shared with the program's own verification runs and carries a hard
 * spend cap, so an uncapped public endpoint could drain the budget those runs
 * depend on. Two facts make that a non-issue: the demonstration data is static
 * (a finished ten-anchor stream, a completed bond lifecycle), and an attestation
 * is a signature over exact bytes — a cached response is exactly as verifiable
 * as a fresh one. So we cache hard at the edge and upstream spend tracks cache
 * misses rather than visitors.
 */

const ALLOWED_DEPLOYMENTS = new Set([
  "QmdfH3RytY2t5arbFehPmL4wyzejRaRVmN5PyhyKVJPiaz", // item 01 — private-bond anchors
  "QmWcifKxjEKSg1nVerGXjmF5jbydj4RKtQgVvvxJBFyVs6", // item 02 — anchor data edge
]);

const MAX_QUERY_BYTES = 2048;
const EDGE_TTL_SECONDS = 21600; // 6h; the underlying data does not change
const RATE_LIMIT = { max: 20, windowSeconds: 60 };

const cors = (origin) => ({
  "access-control-allow-origin": origin ?? "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  // Without this the browser cannot read the attestation, which is the point.
  "access-control-expose-headers": "graph-attestation, x-gps-cache, x-gps-note",
  "access-control-max-age": "86400",
});

const json = (obj, status, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors(), ...extra },
  });

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Best-effort per-IP limiter. Cache-backed, so it is approximate across colos —
 *  enough to stop a naive loop, not a substitute for the spend cap itself. */
async function rateLimited(request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "anon";
  const bucket = Math.floor(Date.now() / (RATE_LIMIT.windowSeconds * 1000));
  const key = new Request(`https://rl.invalid/${encodeURIComponent(ip)}/${bucket}`);
  const cache = caches.default;
  const seen = await cache.match(key);
  const n = seen ? Number(await seen.text()) : 0;
  if (n >= RATE_LIMIT.max) return true;
  await cache.put(
    key,
    new Response(String(n + 1), {
      headers: { "cache-control": `max-age=${RATE_LIMIT.windowSeconds}` },
    }),
  );
  return false;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    // Kill switch: flip the secret without redeploying if the budget needs protecting.
    if (env.DISABLED === "1") {
      return json({ error: "The attested-query proxy is temporarily disabled. The rest of the verification page works without it." }, 503);
    }

    const deployment = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (!ALLOWED_DEPLOYMENTS.has(deployment)) {
      return json({ error: "Unknown deployment. This proxy serves only the two showcase deployments." }, 404);
    }

    const body = await request.text();
    if (body.length > MAX_QUERY_BYTES) return json({ error: "Query too large." }, 413);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
    if (typeof parsed?.query !== "string") return json({ error: "Body must carry a `query` string." }, 400);
    // Reads only. Nothing here should ever mutate, and a mutation would just fail
    // upstream, but refusing it here keeps the surface honest.
    if (/\bmutation\b|\bsubscription\b/i.test(parsed.query)) {
      return json({ error: "Read-only proxy." }, 400);
    }

    const cache = caches.default;
    const cacheKey = new Request(
      `https://gps-proxy.invalid/${deployment}/${await sha256Hex(body)}`,
      { method: "GET" },
    );

    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      Object.entries(cors()).forEach(([k, v]) => h.set(k, v));
      h.set("x-gps-cache", "hit");
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    if (await rateLimited(request)) {
      return json({ error: `Rate limit: ${RATE_LIMIT.max} uncached queries per minute. The cached path is unaffected.` }, 429);
    }

    let upstream;
    try {
      upstream = await fetch(`https://gateway.thegraph.com/api/deployments/id/${deployment}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GRAPH_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch (e) {
      return json({ error: "Upstream gateway unreachable.", detail: String(e) }, 502);
    }

    const text = await upstream.text();
    const attestation = upstream.headers.get("graph-attestation");

    if (!upstream.ok) {
      // Most likely the shared key's spend cap. Say so plainly rather than
      // returning an opaque failure the page cannot explain.
      const note =
        upstream.status === 402 || upstream.status === 429
          ? "The gateway declined the query — most likely the API key's spend cap. Everything else on this page keeps working: it needs no key."
          : `The gateway returned HTTP ${upstream.status}.`;
      return json({ error: note, upstreamStatus: upstream.status }, 502, { "x-gps-note": "upstream-declined" });
    }

    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": `public, max-age=${EDGE_TTL_SECONDS}`,
      "x-gps-cache": "miss",
      ...cors(),
    });
    // Preserve the attestation: it is the artifact the page verifies.
    if (attestation) headers.set("graph-attestation", attestation);

    const response = new Response(text, { status: 200, headers });
    // Cache a copy without the CORS headers baked to a single origin.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
