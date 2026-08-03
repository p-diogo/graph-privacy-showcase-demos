# Attested-query proxy

A public page cannot carry a gateway API key, so the browser cannot query The
Graph's decentralized network directly. This Worker holds the key and forwards a
narrow, read-only set of queries for the two showcase deployments.

**You do not have to trust it.** Every response it returns carries the serving
indexer's EIP-712 attestation over the exact request and response bytes. The
verification page checks that signature in the browser and resolves the signer to
a staked allocation on Arbitrum. A proxy that altered a byte would break the
signature — which is the property the page exists to demonstrate.

## Spend control

The key is shared with the program's own verification runs and carries a hard
spend cap, so an uncapped public endpoint could drain the budget those runs
depend on. Three things keep that from happening:

- **Edge caching, 6 hours.** The demonstration data is static, and an attestation
  is a signature over exact bytes, so a cached response verifies exactly as a
  fresh one does. Upstream spend tracks cache misses, not visitors.
- **A hard allowlist**: two deployment IDs, POST only, 2 KB query ceiling,
  read-only.
- **Per-IP rate limiting** on uncached queries, plus a `DISABLED` kill switch that
  turns the proxy off without a redeploy.

If the cap is reached anyway the proxy says so in plain language, and the rest of
the verification page is unaffected — every other check on it is keyless.

## Deploy

```sh
npx wrangler secret put GRAPH_GATEWAY_KEY   # paste when prompted; never in a file
npx wrangler deploy
```

To disable without redeploying: `npx wrangler secret put DISABLED` and enter `1`.
