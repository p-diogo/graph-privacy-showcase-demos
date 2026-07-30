# Item 01 test map

Where each layer of the spec's §7 test plan lives, and what it actually
covers. Nothing below is aspirational: every row runs, and the program's build report (kept in the private program repo)
records the verbatim output.

## Running everything

```bash
# contracts + ground-truth vector generation  (12 tests)
cd src/contracts && forge test

# CLI: unit, PoC vectors, ground truth, gateway path, determinism  (79 tests)
cd src/replay && cargo test

# subgraph mappings  (7 tests)
cd src/subgraph && npm install && npm test

# full stack: anvil -> PrivateBond -> graph-node -> gateway shim -> CLI  (14 checks)
./tests/integration/run-local-e2e.sh
```

The first three are hermetic and need no services, and each is self-sufficient
on a clean checkout: `forge test` creates the fixture directory it writes to,
and `npm test` renders the templated manifest and runs codegen before testing.

The last needs Docker. It is safe to run repeatedly: it tears down both the
chain and graph-node's store at the start of every run and again on exit.
Resetting only one of the two produces a confusing failure — see the
operational note in the program's build report.

## §7 layer by layer

### Unit — CLI

| Spec item | Where |
|---|---|
| Commitment recompute vs the PoC's own vectors | `src/replay/tests/poc_vectors.rs` |
| Root algorithm vs contract ground truth, 1..12 leaves | `src/replay/tests/root_ground_truth.rs`, vectors from `src/contracts/test/RootGroundTruth.t.sol` |
| Attestation verify/recover round-trip | `src/replay/src/attestation.rs` tests, using `thegraph-core`'s own published vector |
| Request-string byte-equality vs the gateway | `src/replay/src/gateway.rs` tests |
| Completeness accounting, both directions | `src/replay/tests/gateway_path.rs` |

The commitment and root tests are anchored twice over, on purpose. The PoC's
`Prover.toml` and Noir tests pin what *their* circuit computes; the Foundry
vectors pin what the *deployed contract* computes. A reimplementation that
matched only one of those would be a live audit hazard, since `knownRoots` is
populated by the contract while the records come from their wallet.

### Integration — local, hermetic

| Spec item | Where |
|---|---|
| Anvil: deploy PoC, run all five entry points, assert storage | `src/seed/seed-local.sh` step 7 |
| Local graph-node with call handlers; entity log equals expectation | `tests/integration/run-local-e2e.sh` steps 3–4 |
| Mock gateway: fetch → verify → reconcile | `src/replay/tests/gateway_path.rs` |
| Signer resolution against a stubbed network subgraph | `src/replay/src/attestation.rs` tests, stub in `src/replay/src/mock_gateway.rs` |

### Tamper and negative

All six cases the spec names, each asserted to fail *where it should*:

| Case | Where |
|---|---|
| Tampered record fails, naming the record | `gateway_path.rs`, E2E step 10 |
| Tampered response byte fails attestation | `tamper.rs` tests, E2E step 11 |
| Re-signed tampered anchors fail root replay **and only root replay** | `tamper.rs` tests, E2E step 12 |
| Wrong attestation domain fails resolution | `attestation.rs` tests |
| Missing `graph-attestation` header fails closed | `gateway_path.rs` |
| Divergent indexers exit nonzero with both attestations kept | `gateway_path.rs`, `consistency.rs` tests |

Tripwire 3 is the one worth reading the assertions on. It only demonstrates
anything because the tampered body is **re-signed** with a valid key: without
that it would collapse into tripwire 2, and the demo would prove nothing
beyond "edited bytes are detectable". The test asserts the attestation still
passes and that the failure lands on root replay.

### Determinism

`src/replay/tests/determinism.rs` plus E2E step 9. Three properties: fixture
generation is byte-identical across runs, reconciling the same bundle twice
produces byte-identical reports, and reordered served entities produce the
same conclusions. The report test also asserts the *absence* of wall-clock
fields, so nobody reintroduces one.

### Network — not run

The `bond-replay consistency` command's live leg, the §4.3 go/no-go smoke
test, and publishing to the network are all pending. See the program's build report (private);
those steps are documented in REPRODUCE.md and marked as not executed.

## What a green run does not mean

The gateway shim used throughout is **not a gateway**. Its attestations are
signed by throwaway keys with no allocation and no stake behind them. A green
suite is evidence that the audit path is correct and that tampering is caught;
it is no evidence at all about the decentralized network, about indexer
independence, or about anything an attestation's economic backing would imply.
