# Reproducing item 01

Two modes, and the split is deliberate.

**Mode A — verify the canonical deployment (default).** The program deployed
one canonical instance: contracts on Ethereum Sepolia, subgraph published to
the decentralized network on Arbitrum One (2026-07-29). Its address book is
[`deploy/canonical.json`](../../deploy/canonical.json). You run only the CLI
verification cycle against it — no deploying, no publishing, no funded key.
Nobody rebuilds the stack to check us.

**Mode B — full local rebuild.** The original from-zero path, unchanged:
Part A deploys the PoC to a local chain and runs the replay end to end,
including the tamper demos; Part B deploys and publishes your own network
instance.

---

# Mode A — verify the canonical deployment

## What you need

| | |
|---|---|
| Rust toolchain | builds the `bond-replay` CLI |
| jq | reads `canonical.json` in the commands below |
| `GRAPH_API_KEY` | a gateway API key with query credit — environment only, never a file in this repo |
| A Sepolia RPC URL | your own; see "A note on `--rpc-url`" below |

## A-1 · Build the CLI and load the canonical values

```bash
cd items/01-private-bond-replay/src/replay
cargo build --release
mkdir -p ../../build

CANON=../../../../deploy/canonical.json
DEPLOYMENT=$(jq -r '.items["01-private-bond-replay"].subgraph.deploymentId' $CANON)
BOND=$(jq -r '.items["01-private-bond-replay"].contracts.privateBond' $CANON)
NETWORK_SUBGRAPH_ID=$(jq -r '.protocol.networkSubgraphId' $CANON)

# Current (Horizon) DisputeManager on Arbitrum One — the attestation domain's
# verifyingContract. The CLI's built-in default is the legacy address and is
# stale until the specced change lands; pass this explicitly. Spec §4.4 step 4
# has the model, the evidence, and where to re-discover it if it moves again.
DISPUTE_MANAGER=0x2FE023a575449AcB698648eD21276293Fa176f96

export GRAPH_API_KEY=…   # from your environment
```

Every address and ID above comes from `canonical.json`; nothing in this file
repeats them, so there is nothing here to go stale.

## A-2 · Fetch the attested anchor set

```bash
./target/release/bond-replay fetch \
  --gateway https://gateway.thegraph.com \
  --deployment "$DEPLOYMENT" \
  --out ../../build/audit-bundle.json
```

`fetch` resolves the chain head via `_meta` once and pins every query to that
block; the bundle records the pinned block. To re-run against the same view —
which is what makes two runs byte-comparable — pass the recorded block back
with `--block-number`.

## A-3 · Verify the attestation and resolve the signer

```bash
./target/release/bond-replay verify-attestation \
  --bundle ../../build/audit-bundle.json \
  --dispute-manager "$DISPUTE_MANAGER" \
  --network-subgraph "https://gateway.thegraph.com/api/$GRAPH_API_KEY/subgraphs/id/$NETWORK_SUBGRAPH_ID"
```

Two current caveats, both scheduled to disappear with the specced CLI change
(spec §4.4 step 4):

- **`--dispute-manager` must be passed explicitly.** The CLI's default is the
  legacy DisputeManager; under it, recovery yields a well-formed but
  meaningless address that resolves to nothing — the exact production failure
  that produced the v1.2 correction.
- **The network-subgraph request carries no auth header**, so the endpoint
  must embed the key (the gateway's inline-key form above) or be one you run
  yourself.

Expected today: all checks pass and the signer resolves to the Edge & Node
upgrade indexer — the only party serving while the ASSUMPTION-002 window runs
(day 0). That is attribution, not validation, and the upgrade indexer never
counts toward the two-indexer gate.

## A-4 · Reconcile against the served anchors and the chain

```bash
./target/release/bond-replay reconcile \
  --bundle ../../build/audit-bundle.json \
  --manifest ../../deploy/artifacts/records-manifest.json \
  --records-dir ../../deploy/artifacts/records \
  --rpc-url <your Sepolia RPC> --contract "$BOND" \
  --dispute-manager "$DISPUTE_MANAGER" \
  --verify-onchain
```

`--bundle` must be the bundle A-2 just wrote. `reconcile` reads whatever sits
at that path, and `build/` is gitignored working space — a leftover bundle
from an earlier session (or from a Mode-B local run) fails anchor accounting
in a way that looks like a deployment defect. To reconcile the canonical
run's own capture instead, point `--bundle` at
`../../deploy/evidence-modea/audit-bundle.json`.

The disclosed record set ships in `deploy/artifacts/` precisely so a Mode-A
run does not re-derive it (it is regenerable byte-for-byte; see
`canonical.json`). Expect every table green and exit 0. The canonical run's
own bundle and report are in `deploy/evidence-modea/` for comparison.

## A-5 · Optional: the teeth

```bash
./target/release/bond-replay tamper --tripwire altered-record \
  --record bond_investor-a_2000001.json --field value \
  --bundle ../../build/audit-bundle.json \
  --manifest ../../deploy/artifacts/records-manifest.json \
  --records-dir ../../deploy/artifacts/records \
  --rpc-url <your Sepolia RPC> --contract "$BOND"
```

`bond-replay consistency --min-signers 2` **cannot pass today**: one serving
indexer. The targeted per-indexer route it depends on is production-confirmed
(spec §9.5), so once the ASSUMPTION-002 gate seats two independent indexers,
consistency mode is runnable as written — until then, do not present a
single-signer run as coverage.

## Mode-A scope

Everything in "Scope, in plain terms" at the bottom of this file applies
verbatim — MockVerifier included: nothing in Mode A is evidence about the
PoC's ZK layer. And an audit run leaks its own subject: the gateway and the
serving indexer see which deployment you audited, the full query text, and
when.

---

# Mode B — full local rebuild

The original two-part path. Everything below is unchanged from v1.1 except
where the canonical deployment made a status line false.

## What you will have proven at the end of Part A

That a disclosed set of off-chain bond records reconciles against the anchor
set served by an indexer *and* against the roots the contract recorded on
chain — and that altering any one of the record, the served bytes, or the
anchor log makes it fail, in three distinguishable places.

What you will **not** have proven: anything about the decentralized network.
Part A's gateway is a local shim signing with throwaway keys that hold no
stake. Read the scope note at the end before quoting any of this.

---

## Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Rust | 1.97.1 | `rustup` default toolchain is fine |
| Foundry | 1.4.4-stable | `foundryup`; `forge`, `cast`, `anvil` |
| Node | 22.23.0 | npm 10.x |
| Docker | 29.4.0 | daemon running; graph-node runs under emulation on arm64 |
| jq | any recent | |

No credentials of any kind are needed for Part A. No credential belongs in
this repo, ever.

---

# Part A — local

## A1 · Fetch the pinned PoC

```bash
cd items/01-private-bond-replay
./src/poc/fetch-poc.sh
```

Clones `ethsystems/pocs` at `94f1e5c94b6c4896977ae68094b99479eef4c371` into
`build/poc/`, checks out its pinned submodules, and symlinks them into our
Foundry project. The script aborts if HEAD is not the pinned SHA or if the
upstream layout has moved.

Their code is never modified. `src/contracts/` holds only our own additions:
a copy of their test `MockVerifier`, deploy and seed scripts, the tests, and
the Fallback B stand-in.

## A2 · Generate ground-truth vectors and run the contract tests

```bash
cd src/contracts && forge test
```

Expect **12 passed**. This also writes `build/fixtures/root-vectors.json` and
`build/fixtures/poseidon-pair-vectors.json`, produced by driving
`PrivateBond.buildMerkleRoot()` itself over 1..12 leaves. The Rust tests check
against these, so the contract — not our reading of it — is the authority on
the tree.

The test creates `build/fixtures/` itself; you do not need to make it first.
Run this before A3, which reads what it writes.

## A3 · Run the CLI test suite

```bash
cd ../replay && cargo test
```

Expect **79 passed** across six binaries. Includes the PoC's own `Prover.toml`
vectors, the contract ground truth, `thegraph-core`'s published attestation
vector, and the determinism assertions.

## A4 · Seed a local chain

```bash
cd ../.. && ./src/seed/seed-local.sh
```

This starts anvil at a **fixed genesis timestamp** (1893456000), deploys
`PrivateBond` behind `MockVerifier`, and runs the full eight-leaf lifecycle
through all five anchor-writing entry points: `mint`, `mintBatch`, `transfer`,
`atomicSwap`, then `burn` after warping past maturity. It finishes by
asserting all 8 leaves, all 5 anchored roots, and the `bondId` against the
generated fixtures.

The fixed timestamp is what makes the anchor log byte-reproducible: maturity is
a constant rather than deploy-time plus an hour.

Set `KEEP_ANVIL=1` to leave the chain running.

## A5 · Run the subgraph mapping tests

```bash
cd src/subgraph && npm install && npm test
```

Expect **7 passed**.

Use `npm test`, not `npx graph test`. The manifest is a template carrying
`{{network}}`/`{{address}}`/`{{startBlock}}` placeholders, and the mappings
import generated types, so neither exists on a clean checkout. `npm test`
renders the manifest and runs codegen first. With no chain seeded yet it falls
back to `config/local-default.json`; once you have deployed, it picks up the
real generated config automatically.

`npm install` reports vulnerabilities in the matchstick dependency tree (old
`glob`/`uuid`/`rimraf` transitives). They are dev-only test tooling and do not
affect anything this item builds or serves.

## A6 · The whole path, end to end

```bash
cd ../.. && ./tests/integration/run-local-e2e.sh
```

Expect **14 passed, 0 failed**. This script does everything: tears down any
stack a previous run left behind, seeds a fresh chain, brings up graph-node on
a clean store, deploys the call-handler subgraph, waits for the anchor log,
starts the gateway shim, then runs `fetch` → `verify-attestation` →
`reconcile --verify-onchain`, checks the report is byte-identical across runs,
and fires all three tripwires.

It is safe to run repeatedly. Both the chain and the indexer store are reset at
the start of every run, and both are torn down on exit — the two together,
because resetting only one produces a confusing failure rather than a clean
one.

If you want to drive the CLI by hand instead, with the stack from A6 running:

```bash
cd src/replay
BUILD=../../build
DEPLOYMENT=<the Qm... printed at step 3>
BOND=$(jq -r .privateBond $BUILD/deployment.json)

./target/release/bond-replay fetch \
  --gateway http://127.0.0.1:8999 --deployment "$DEPLOYMENT" --out $BUILD/audit-bundle.json

./target/release/bond-replay verify-attestation --bundle $BUILD/audit-bundle.json

./target/release/bond-replay reconcile \
  --bundle $BUILD/audit-bundle.json \
  --manifest $BUILD/records-manifest.json \
  --records-dir $BUILD/records \
  --rpc-url http://127.0.0.1:8545 --contract "$BOND" --verify-onchain

./target/release/bond-replay tamper --tripwire altered-record \
  --record bond_investor-a_2000001.json --field value \
  --bundle $BUILD/audit-bundle.json --manifest $BUILD/records-manifest.json \
  --records-dir $BUILD/records --rpc-url http://127.0.0.1:8545 --contract "$BOND"
```

`reconcile` exits nonzero on any failure, and `tamper` exits zero only when the
tampering was caught.

### A note on `--rpc-url`

Point it at your own node. The root replay is the only check in the tool whose
trust is anchored somewhere other than the serving layer, and it is worth
nothing if the RPC endpoint is one we chose for you.

## A7 · Fallback A, if you want to see it

```bash
cd src/subgraph
npx mustache ../../build/subgraph-config.json subgraph.fallback-a.yaml > subgraph.fallback-a.local.yaml
npx graph codegen subgraph.fallback-a.local.yaml
npx graph create --node http://127.0.0.1:8020 private-bond-anchors-fallback-a
npx graph deploy --node http://127.0.0.1:8020 --ipfs http://127.0.0.1:5001 \
  --version-label v0.1.0 private-bond-anchors-fallback-a subgraph.fallback-a.local.yaml
```

Serves the identical commitment log with no trace dependency, at the documented
cost: no nullifiers, no claimed roots, `sourceFunction` UNKNOWN throughout.

---

# Part B — the network leg, on your own instance

**[v1.2]** The program's canonical instance has executed this leg once —
deployed, seeded, verified on-chain, published, and queried through the
production gateway with attestations captured (`deploy/canonical.json`;
runbook: `deploy/RUNBOOK.md`). Running Part B yourself therefore creates a
**second, non-canonical instance of your own** — record it nowhere near
`canonical.json`; a reader who finds two addresses will try the wrong one.
Two axes matter below and the labels now separate them: **Canonical status**
is what the program's one canonical instance has already done (authoritative
record: `../../deploy/canonical.json`); the **step label** describes what
applies to YOUR optional second run. Canonical summary as of 2026-07-29:
B2 DONE · B3 DONE · B4 DONE (Mode A is the no-deploy way to consume it) ·
B1's ≥2-indexer gate IN PROGRESS (smoke window day 0) · B5 not applicable
until canonical teardown, which is not planned.

## B1 · `[GATE — canonical status: IN PROGRESS, smoke window day 0]` Trace-capable Sepolia indexers

**Gate, owner the program owner (ASSUMPTION-002).** Call handlers need trace-capable chain
data. Before anything is published, run the item-owned go/no-go: deploy a
trivial call-handler smoke subgraph and observe it served by ≥2 of the arranged
Sepolia indexers.

Locally this question is answered — anvil 1.4.4 implements `trace_filter` and
the call-handler subgraph indexes correctly against it (recorded in the program's build report, kept private).
That says nothing about Sepolia indexer capability, which is the actual gate.

If the gate fails, **Fallback A becomes the design**, not a contingency, and
the gate re-runs against it.

## B2 · `[YOUR RUN ONLY — canonical status: DONE 2026-07-29]` Deploy to Sepolia

Needs a funded key and an RPC URL. Same contracts, same seed lifecycle, but
maturity becomes deploy-time + 1 hour rather than the fixed fixture constant,
so the anchor log will not match Part A's byte for byte.

Before deploying, re-diff `ethsystems/pocs` against the pin: it was pushed the
day we pinned it and is labelled In Progress. A material contract change is a
decision, not something to absorb silently.

**Also open, owner the program owner:** whether to tell EthSystems before deploying their
code. The `bondId` and subgraph name make the deployment attributable.

## B3 · `[YOUR RUN ONLY — canonical status: DONE 2026-07-29]` Publish to the network

Studio → publish → curation signal → wait for the arranged indexers to
allocate. Needs curation GRT and a gateway API key with query credit — yours
to provision for your own instance (the canonical instance's were provisioned
2026-07-29).

## B4 · `[YOUR RUN ONLY — canonical status: DONE 2026-07-29, both Mode-A runs PASS]` Run the CLI against the production gateway

```bash
bond-replay fetch --gateway https://gateway.thegraph.com --deployment <Qm...>
bond-replay reconcile --rpc-url <your Sepolia RPC> --contract <address> --verify-onchain
bond-replay consistency --min-signers 2 --network-subgraph <endpoint>
```

Two things were unverified when this was written; the canonical run settled
both (2026-07-29):

- **The attestation domain — settled.** Resolution did fail systematically
  under the legacy DisputeManager, and the escalation found the cause: under
  Horizon the domain's `verifyingContract` is the **current** DisputeManager,
  and the recovered signer is still the allocation ID. Model, evidence, and
  sources: spec §4.4 step 4. Pass `--dispute-manager` explicitly (Mode A
  shows how) until the CLI default moves.
- **The targeted per-indexer route — settled.** Production-confirmed working;
  the canonical attestation captures were made through it
  (`deploy/evidence/assumption-002/`). It remains the only route that can
  support a k-distinct-signer claim; the best-effort fallback still refuses to
  describe itself as coverage.

**Do not** set `--api-key` from a file in this repo. Use the environment.

## B5 · `[YOUR RUN ONLY]` Cleanup

Withdraw curation signal, rotate any key that touched a funded account.

---

## Scope, in plain terms

Read this before quoting any output above.

- **The Graph is not a privacy technology here.** The bond's confidentiality
  comes from the PoC's own design. This item indexes its public surface and
  serves the read and audit path. Nothing more.
- **Attestations are signatures, not validity proofs.** They make a wrong
  answer attributable, and slashable where the signer resolves to a staked
  allocation. They never make an answer correct. In Part A the signer holds no
  stake at all.
- **Completeness is with respect to on-chain anchors.** A record the issuer
  never anchored is invisible to every check here. This is not, and cannot be
  turned into, a proof of reserves. The cash legs — subscription, redemption
  settlement — are outside all of it.
- **Read privacy does not exist.** An audit run tells the gateway and every
  serving indexer which deployment was audited, the full query text, and when.
  An audit is unusually revealing that way: the target is exactly the thing
  leaked. Item 06 designs the ladder; only its L0 rung (self-hosting, which is
  what Part A is) closes the leak today, and it does so by giving up the
  network's attestations and independence.
- **The MockVerifier deployment says nothing about the PoC's ZK layer.** It is
  the spec's pre-decided default because generating real proofs needs a
  toolchain this tranche does not run. Anchors land in storage and calldata
  regardless of proof validity, which is why the audit-read claims do not
  depend on it.
- **`proof` arguments in the fixtures are placeholder bytes.** They are not
  proofs and nothing may present them as such.
