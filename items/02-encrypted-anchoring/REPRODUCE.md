# REPRODUCE — item 02, encrypted payload anchoring

Two modes, and the split is deliberate.

**Mode A — verify the canonical deployment (default).** The program deployed
one canonical instance: `AnchorDataEdge` on Ethereum Sepolia, the canonical
10-anchor stream (plus two deliberate edge-case posts), and the subgraph
published to the decentralized network on Arbitrum One (2026-07-29). Its
address book is [`deploy/canonical.json`](../../deploy/canonical.json). You
run only the checker against it — no deploying, no posting, no funded key.

**Mode B — full local rebuild.** The original from-zero path, unchanged:
steps 0–9 are local only (no public network, no spending, no gateway); steps
10–12 stand up your own network instance.

---

# Mode A — verify the canonical deployment

## What you need

| | |
|---|---|
| Node 22 + pnpm | builds the writer/checker CLIs |
| jq, curl | read `canonical.json` and resolve a pin in the commands below |
| `GRAPH_API_KEY` | a gateway API key with query credit — environment only, never a file in this repo |
| A Sepolia **archive** RPC | your own, for the chain cross-check |
| **The canonical disclosure bundle** | see below — it is not in this repo |

**The disclosure gate.** The checker reconciles a *disclosure* (plaintext
records + stream keyfile) against the served index, and the canonical
disclosure bundle lives **outside the repository by design** — it contains the
stream key, and publishing it is a pending decision
(`disclosurePublishedAt: null` in `canonical.json`). Until that decision,
obtain the bundle from the program owner. Without it you can still query the
canonical index directly (the no-setup query in
[`CANONICAL.md`](../../CANONICAL.md)) but you cannot run the checker. Once the
key is public, anyone can post conflicting anchors at existing seqs; the
checker flags those as `CONFLICT` — the tool working, not the demo breaking.

## A-1 · Build and load the canonical values

```bash
cd items/02-encrypted-anchoring
pnpm install && pnpm build

CANON=../../deploy/canonical.json
DEPLOYMENT=$(jq -r '.items["02-encrypted-anchoring"].subgraph.deploymentId' $CANON)
DISCLOSURE=…    # path to the canonical disclosure bundle you obtained
export GRAPH_API_KEY=…   # from your environment
```

Every address and ID comes from `canonical.json`; nothing in this file repeats
them.

## A-2 · Pin a block — not optional

Unpinned gateway runs are not reproducible; **every gateway run below passes
`--block`.** Resolve one pin and reuse it for every command:

```bash
BLOCK=$(curl -s "https://gateway.thegraph.com/api/deployments/id/$DEPLOYMENT" \
  -H "authorization: Bearer $GRAPH_API_KEY" -H 'content-type: application/json' \
  -d '{"query":"{_meta{block{number}}}"}' | jq -r .data._meta.block.number)
```

Any block at or after the full seed window works. One subtlety worth knowing:
`stream.endBlock` in `canonical.json` marks the last of the 10 anchors, and
the two deliberate edge-case posts landed shortly *after* it — a pin at
`endBlock` verifies the 10-anchor stream but will not show the `DUPLICATE`
and `MALFORMED` notes. A later pin (such as the current head resolved above)
reproduces the full canonical picture.

## A-3 · Reconcile through the gateway

```bash
node dist/completeness-checker/cli.js verify --disclosure "$DISCLOSURE" \
  --source gateway \
  --url "https://gateway.thegraph.com/api/deployments/id/$DEPLOYMENT" \
  --api-key "$GRAPH_API_KEY" \
  --block "$BLOCK" \
  --evidence .local/attestations
```

Expect exit 0, with two notes and no findings: the seq-0 re-submission as
`DUPLICATE` and the junk payload as `MALFORMED` — both are deliberate
canonical seeds (`canonical.json` records their txs), publicly reported rather
than dropped, and neither invalidates the disclosure. The
`graph-attestation` header lands in `.local/attestations/`.

The canonical first run of this exact command is preserved in
`deploy/evidence-modea/` — it predates the `--block` rule and was unpinned,
which is precisely why the rule is now mandatory; treat it as evidence the run
happened, not as a reproducible baseline.

## A-4 · Cross-check against raw chain data

```bash
# no Graph component in the trust path: rebuild the set from raw blocks
node dist/completeness-checker/cli.js verify --disclosure "$DISCLOSURE" \
  --source chain --rpc <your Sepolia archive RPC> --to-block "$BLOCK"

# and both sources against each other, entity for entity
node dist/completeness-checker/cli.js verify --disclosure "$DISCLOSURE" \
  --source gateway \
  --url "https://gateway.thegraph.com/api/deployments/id/$DEPLOYMENT" \
  --api-key "$GRAPH_API_KEY" --block "$BLOCK" \
  --cross-check-chain --rpc <your Sepolia archive RPC> --to-block "$BLOCK"
```

`--contract` and `--from-block` default from the disclosure manifest. All runs
exit 0.

## A-5 · The attestation, verified deeply

This checker records the attestation; it does not verify the signature or
resolve the signer — that is item 01's deliverable, reused rather than
re-implemented. To verify a captured attestation offline, use item 01's
`bond-replay verify-attestation` with the **current (Horizon) DisputeManager**
as the domain's `verifyingContract` — the CLI's legacy default fails
resolution; item 01's spec §4.4 step 4 has the confirmed model and item 01's
REPRODUCE Mode A the exact command. The canonical capture for this item
(`deploy/evidence/assumption-002/`, bond-replay bundle format) recovers under
that domain to the network-subgraph-enumerated allocation byte for byte.

## Mode-A scope

The scope notes at the top of Mode B apply verbatim: completeness is with
respect to anchored emissions, never off-chain reality — no proof-of-reserves
framing; and every query tells the gateway and the serving indexer which
stream you are auditing, and when. One serving indexer today (the upgrade
indexer, while the ASSUMPTION-002 window runs); a single-signer run is not
independent-serving evidence.

---

# Mode B — full local rebuild

From zero, on a machine you control. Everything below is unchanged from v1.1
except where the canonical deployment made a status line false.

What a completed local run demonstrates: client-side-encrypted records are
anchored on a chain as ciphertext digests in pure calldata, a call-handler
subgraph turns those anchors into an index of existence, ordering and
completeness, and a checker reconciles a disclosure against that index —
failing loudly, and by name, when a record is restated, a record is withheld,
a server withholds anchors, or a server breaks the hash chain.

What it does **not** demonstrate: anything about off-chain reality. The
checker proves the disclosed records are exactly what was anchored. It cannot
prove the anchored set is complete with respect to the world. No proof of
reserves, anywhere. And read privacy does not exist here: every query tells
the operator serving it which stream you are auditing and when.

---

## 0 · Prerequisites

| Tool | Version used | Why |
|---|---|---|
| Node | 22.23.0 | writer/checker CLIs, subgraph tooling |
| pnpm | 10.10.0 | workspace install |
| Foundry (forge, cast, anvil) | 1.4.4-stable | contract build/deploy, local chain |
| Docker + compose | 29.4.0 / v5.1.2 | local graph-node, IPFS, Postgres |
| jq, curl, lsof | any | integration harness |
| Python 3 with `cryptography` | 3.14.6 / 46.0.5 | *optional* — cross-checks the AEAD against OpenSSL |

Install Foundry with `curl -L https://foundry.paradigm.xyz | bash && foundryup`
(user-local, no sudo). Everything else is either already present on macOS/Linux
or installs into the repo.

The local stack publishes ports **18000, 18001, 18020, 18030, 18040, 15001,
15432** and the chain listens on **18545**. They are non-default on purpose, so
this stack can run beside another graph-node stack; the harness refuses to
start if any of them is occupied rather than talk to a node it did not start.

```bash
cd items/02-encrypted-anchoring
pnpm install
```

`src/contracts/lib/forge-std` is not vendored. Fetch it once:

```bash
git clone --depth 1 --branch v1.11.0 https://github.com/foundry-rs/forge-std \
  src/contracts/lib/forge-std && rm -rf src/contracts/lib/forge-std/.git
```

## 1 · Contract tests

```bash
forge test --root src/contracts -vv
```

Ten tests: the selector `0x330a5405` is stable, the envelope is 105 bytes, the
contract emits nothing, writes no storage, rejects value and unknown selectors,
and an anchor call stays under 30k gas.

## 2 · Determinism and unit tests

```bash
pnpm build
pnpm test
```

54 tests. The ones that matter most:

- **golden vectors** — `fixtures/records.jsonl` + `fixtures/demo-keyfile.json`
  must reproduce `fixtures/golden/anchors.json` byte for byte. The demo key is
  published on purpose and re-derivable: `streamId = keccak256("graph-privacy-showcase/item-02/demo-stream-id")`,
  `streamKey = keccak256("graph-privacy-showcase/item-02/demo-stream-key-THROWAWAY")`.
- **independent AEAD cross-check** — the same plaintext, key, nonce and AAD
  encrypted by Python's `cryptography` (OpenSSL) must equal our `@noble/ciphers`
  output. Skipped automatically when Python or the module is missing.
- **AAD position binding** — a ciphertext moved to another seq or another
  stream fails tag verification.
- **verdict engine** — every verdict the checker advertises fires on a
  constructed input, and findings do not cascade.

## 3 · Mapping unit tests (matchstick, no chain)

`subgraph.yaml` is generated, never committed — a pinned address that is not the
one you deployed is a lie waiting to be copied. For codegen alone, any
well-formed address will do:

```bash
node dist/tools/gen-manifest.js --network anvil-local \
  --address 0x0000000000000000000000000000000000000000 --start-block 0
cd src/subgraph
pnpm exec graph codegen
pnpm exec graph test
cd ../..
```

7 tests. They assert the AssemblyScript decoder against the *same* golden
envelopes the TypeScript writer produces, so the two implementations cannot
drift apart silently.

`graph test` downloads a matchstick binary on first run. If your platform has
no binary, `pnpm exec graph test -d` runs it in Docker instead.

## 4 · One command for the whole local pipeline

```bash
tests/integration/run.sh
```

This is steps 5–9 automated, including cleanup. It exits non-zero if any check
fails and prints `N passed, M failed`. The rest of this section is what it does,
should you want to drive it by hand.

## 5 · Local chain and contract

```bash
anvil --host 0.0.0.0 --port 18545 --silent &
forge build --root src/contracts
forge create --root src/contracts --rpc-url http://127.0.0.1:18545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast --json src/AnchorDataEdge.sol:AnchorDataEdge
```

Record `deployedTo` and the receipt's block number. That key is anvil's first
deterministic account: public, worthless, local-only.

Anvil is used because it answers the Parity **`trace_filter`** RPC, which is
what a call-handler subgraph needs. Confirm on your own node before trusting
the rest:

```bash
cast rpc --rpc-url http://127.0.0.1:18545 trace_filter '{"fromBlock":"0x0","toBlock":"0x1"}'
```

(The spec's §9 open question 5 assumed anvil lacked this. On Foundry 1.4.4 it
does not — recorded in the program's build report, kept private.)

## 6 · Anchor the fixture stream

```bash
node dist/anchor-writer/cli.js post \
  --records fixtures/records.jsonl \
  --keystore fixtures/demo-keyfile.json \
  --contract <deployedTo> \
  --rpc http://127.0.0.1:18545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --archive .local/archive.json
```

Ten transactions, one per record, submitted in seq order and each awaited to a
receipt. `--dry-run` computes and archives everything without touching a chain.

Optional, and worth doing — put two awkward cases on chain, because a real
anchor contract is callable by anyone:

```bash
cast send --rpc-url http://127.0.0.1:18545 --private-key <key> <contract> "postAnchor(bytes)" 0x0102030405
cast send --rpc-url http://127.0.0.1:18545 --private-key <key> <contract> "postAnchor(bytes)" $(jq -r '.anchors[0].envelope' .local/archive.json)
```

Then build the auditor's bundle:

```bash
node dist/anchor-writer/cli.js disclose \
  --archive .local/archive.json --records fixtures/records.jsonl \
  --keystore fixtures/demo-keyfile.json --out .local/disclosure
```

## 7 · Index it

```bash
docker compose -f src/local-stack/docker-compose.yml up -d
node dist/tools/gen-manifest.js --network anvil-local --address <contract> --start-block <block>
cd src/subgraph
pnpm exec graph codegen
pnpm exec graph create --node http://localhost:18020/ anchor-data-edge
pnpm exec graph deploy --node http://localhost:18020/ --ipfs http://localhost:15001 \
  --version-label v0.1.0 anchor-data-edge subgraph.yaml
cd ../..
```

Watch it catch up, and note the block you will pin queries to:

```bash
curl -s http://localhost:18030/graphql -H 'content-type: application/json' \
  -d '{"query":"{ indexingStatusesForSubgraphName(subgraphName: \"anchor-data-edge\") { synced health chains { latestBlock { number } } } }"}' | jq
```

`synced` can be true a block or two behind a freshly mined head; wait for the
height itself before running block-pinned queries.

## 8 · Reconcile

```bash
# served by the local graph-node, pinned to a block so the run is reproducible
node dist/completeness-checker/cli.js verify --disclosure .local/disclosure \
  --source local --endpoint http://localhost:18000/subgraphs/name/anchor-data-edge --block <n>

# rebuilt from raw blocks: no Graph component in the trust path
node dist/completeness-checker/cli.js verify --disclosure .local/disclosure \
  --source chain --rpc http://127.0.0.1:18545 --to-block <n>

# and the two against each other, entity for entity
node dist/completeness-checker/cli.js verify --disclosure .local/disclosure \
  --source local --endpoint http://localhost:18000/subgraphs/name/anchor-data-edge \
  --block <n> --cross-check-chain --rpc http://127.0.0.1:18545 --to-block <n>
```

All three exit 0. The first two report the junk payload as a `MALFORMED` note
and the re-submission as a `DUPLICATE` note: neither is silently dropped, and
neither invalidates the disclosure.

## 9 · Break it on purpose

Four failures, four distinct exit codes. The first two tamper with the
*disclosure*; the last two are dishonest *servers*, run locally — never point a
tamper test at infrastructure you do not own.

```bash
# 1 · a restated record  -> ALTERED seq=3, exit 2
node dist/tools/tamper.js alter --disclosure .local/disclosure --out .local/d-altered --seq 3
node dist/completeness-checker/cli.js verify --disclosure .local/d-altered \
  --source local --endpoint http://localhost:18000/subgraphs/name/anchor-data-edge --block <n>

# 2 · a withheld record  -> MISSING seq=5 + COUNT-MISMATCH, exit 3
node dist/tools/tamper.js suppress --disclosure .local/disclosure --out .local/d-suppressed --seq 5
node dist/completeness-checker/cli.js verify --disclosure .local/d-suppressed \
  --source local --endpoint http://localhost:18000/subgraphs/name/anchor-data-edge --block <n>

# 3 · a server that withholds anchors -> GAP seq=3, GAP seq=7, exit 4
node dist/tools/gen-manifest.js --variant badserver-gap --network anvil-local \
  --address <contract> --start-block <block>
(cd src/subgraph && pnpm exec graph codegen subgraph.badserver-gap.yaml \
  && pnpm exec graph create --node http://localhost:18020/ anchor-data-edge-gap \
  && pnpm exec graph deploy --node http://localhost:18020/ --ipfs http://localhost:15001 \
     --version-label v0.1.0 anchor-data-edge-gap subgraph.badserver-gap.yaml)
node dist/completeness-checker/cli.js verify --disclosure .local/disclosure \
  --source local --endpoint http://localhost:18000/subgraphs/name/anchor-data-edge-gap --block <n>

# 4 · a server that breaks the chain -> CHAIN-BREAK seq=5, exit 5
#    (same three commands with --variant badserver-chain and name anchor-data-edge-chainbreak)
```

Exit codes: `0` ok · `1` usage/runtime · `2` ALTERED · `3` MISSING · `4` GAP ·
`5` CHAIN-BREAK · `6` CONFLICT · `7` ENVELOPE-MISMATCH · `8` COUNT-MISMATCH.
With several findings the process exits with the lowest code and prints them all.

### Re-index determinism

Wipe the database, re-index the same deployment, and require the same answers:

```bash
docker compose -f src/local-stack/docker-compose.yml down -v
docker compose -f src/local-stack/docker-compose.yml up -d
# redeploy anchor-data-edge exactly as in step 7, wait for the same block, then:
curl -s http://localhost:18030/graphql -H 'content-type: application/json' \
  -d '{"query":"{ proofOfIndexing(subgraph: \"<Qm...>\", blockNumber: <n>, blockHash: \"<hash>\") }"}' | jq -r .data.proofOfIndexing
```

The entity set and the POI must be identical to the first run. `run.sh` asserts
both, and additionally asserts that redeploying produces the same deployment id.

---

## Network leg — on your own instance

**[v1.2]** The program's canonical instance has now executed this leg —
Sepolia deploy, the canonical stream, Studio deploy, Arbitrum One publish, and
a first production gateway verification with the attestation captured
(2026-07-29; `deploy/canonical.json`, `deploy/evidence-modea/`). The
ASSUMPTION-002 window is still running (day 0: upgrade indexer only, never
counted toward the two). Running steps 10–12 yourself creates a **second,
non-canonical instance of your own** — new contract, new stream — and it is
recorded nowhere near `canonical.json`.

**10 · Smoke test (gates ASSUMPTION-002, evidence row E5).** Deploy
`AnchorDataEdge` to Sepolia, post 3 anchors, publish a trivial call-handler
subgraph through Studio, add curation signal, and watch for **7 calendar days**.
Pass criterion: ≥2 distinct non-upgrade indexers each served a correct response
at a pinned block with a valid attestation. The Edge & Node upgrade indexer is
recorded but does not count. This can genuinely fail: EBO's own Sepolia
deployment runs the *eventful* variant because Sepolia trace support is not
ambient, which is exactly what ASSUMPTION-002 has to arrange.

**11 · Flagship publish.** Same manifest with `network: sepolia` and the
Sepolia contract address, published via Studio and curated.

**12 · Gateway verification.**

```bash
node dist/completeness-checker/cli.js verify --disclosure <dir> --source gateway \
  --url https://gateway.thegraph.com/api/subgraphs/id/<deployment> \
  --api-key $GRAPH_API_KEY --block <n> --evidence .local/attestations
```

Gateway mode captures the `graph-attestation` response header alongside the raw
response bytes. It does **not** verify the signature or resolve the signer to an
indexer: that is item 01's deliverable and is reused, not re-implemented here.
An attestation is a signature bound to a staked allocation — non-repudiable and
economically backed, but not a validity proof.

If the smoke gate fails, the documented fallback is Shape 2 (spec §4.6): the
contract gains one event, the subgraph becomes an event-handler deployment that
any indexer can serve, and the E4 wording changes from "pure calldata" to
"calldata + event" in the same session the fallback is invoked.
