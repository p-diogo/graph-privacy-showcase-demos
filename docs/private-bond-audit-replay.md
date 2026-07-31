# Private-bond audit replay

*A live demonstration that The Graph serves the audit read path for a
confidential bond on public Ethereum. Contracts on Ethereum Sepolia; subgraph
published to The Graph's decentralized network. Status as of 2026-07-29.*

## What this is

When an institution issues a confidential instrument on public Ethereum, the
record content stays off-chain and the chain carries only cryptographic
anchors: note commitments, nullifiers, Merkle roots. That keeps positions
private — and it creates an obligation the moment an auditor arrives. Someone
must serve the *complete* anchored record, so the records the issuer chooses
to disclose can be checked against everything that was actually anchored: in
order, nothing missing, nothing rewritten. The
[EthSystems Institutional Privacy Map](https://github.com/ethsystems/map)
(begun as the Ethereum Foundation's Institutional Privacy Task Force)
documents this step precisely — its
[encrypted off-chain audit pattern](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-l2-encrypted-offchain-audit.md)
ends with the auditor instructed to *"replay the log against the anchored
roots to confirm that no record has been rewritten after the fact"* — but it
names no infrastructure that serves the log being replayed.

This PoC makes that step executable today. We deployed EthSystems' own
open-source [private-bond PoC](https://github.com/ethsystems/pocs)
(the `custom-utxo` variant, deployed unmodified at pinned commit `94f1e5c`;
the deployed contract is MIT per its own SPDX header, and their repository is
MIT OR Apache-2.0 except where file headers state otherwise — their code,
credited as such) to Ethereum
Sepolia, seeded a full bond lifecycle on it, indexed its entire anchor
surface with a subgraph published to The Graph's decentralized network, and
built an auditor CLI, `bond-replay`, that: fetches the served anchor set
through The Graph's gateway; verifies the response's EIP-712 attestation
offline and resolves its signer to a staked indexer allocation; and replays a
disclosed set of bond records against both the served anchors and the Merkle
roots the contract recorded on-chain. Altering a disclosed record, a served
byte, or the anchor log itself makes the replay fail loudly — in three
distinguishable places.

The PoC implements EthSystems'
[private-bonds use-case](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/use-cases/private-bonds.md).
Our contribution is the read and audit leg only: the pattern's confidentiality
design is theirs, and the demonstration runs on their artifacts, not a
stand-in.

## How it works

**The contract emits no events.** `PrivateBond` keeps all anchor state in
storage: an append-only `commitments` array, a `knownRoots` mapping holding
every historical Merkle root (recomputed on-chain after every
anchor-appending call), a `nullifiers` mapping of spent notes, and a `bondId`
set at construction. Anchor data arrives as calldata through five functions:
`mint`, `mintBatch`, `transfer`, `burn`, and `atomicSwap`. The canonical
deployment carries a deliberately fictional bond — id string `XF0000000001`,
an ISIN-*format* value that cannot collide with a real security — with a
seeded lifecycle exercising all five entry points: 8 note commitments in
total, of which 6 correspond to disclosed records and 2 are the structural
zero-value outputs the burn path appends.

**The subgraph indexes what has no events.** Because nothing is emitted, the
subgraph uses call handlers on all five anchor-writing functions: indexers
extract each transaction's calldata from execution traces and the mapping
decodes it into entities — `Commitment` (with a deterministic global leaf
index), `Nullifier`, `RootClaimed` (the root each proof-bearing call cited),
`LifecycleCall`, and a `Bond` singleton. The subgraph serves the ordered
anchor log; it deliberately does not rebuild the Merkle tree. Root
reconstruction lives in the auditor CLI, which reimplements the contract's
exact algorithm (PoseidonT3 pairwise over the whole commitment array, odd
node duplicated as its own sibling), so the tree math is checked against the
chain, not against the serving layer.

**The audit flow.** The CLI queries the deployment through The Graph's
gateway. Every paid gateway response carries a `graph-attestation` header: an
EIP-712 signature binding the request hash, the response hash, and the
subgraph deployment id to the indexer's staked allocation. `bond-replay
verify-attestation` recomputes both hashes from the captured bytes, recovers
the signer under the attestation domain (whose `verifyingContract` is the
current DisputeManager on Arbitrum One), and resolves the recovered address —
which *is* the allocation id — against The Graph's network subgraph to a
named indexer and its stake. `bond-replay reconcile` then recomputes each
disclosed record's Poseidon commitment, asserts its presence and claimed
index in the served log, accounts for every served commitment in both
directions (each one is either a disclosed record or a manifest-listed
structural burn output — anything else fails), rebuilds the root after every
anchor-appending call, and asserts each rebuilt root is in `knownRoots` via
`eth_call` against a Sepolia RPC you choose. An optional flag cross-checks
every served commitment against contract storage directly.

**The tamper story — what fails, and where, when someone lies:**

| Lie | What catches it |
|---|---|
| A disclosed record is altered (say, one field of one bond record) | Its recomputed commitment is absent from the served set; reconciliation fails and names the record. |
| A served byte is altered after the fact | The response hash no longer matches the attestation's `responseCID`; attestation verification fails. |
| The serving layer itself lies — altered anchor set, freshly signed, valid attestation | Signature checks pass; root replay diverges from the on-chain `knownRoots`. The chain, not the serving layer, is the root of trust. |

The three failures are distinguishable by design: the first names a record,
the second names the transport, the third isolates the server.

## The Graph's role, precisely

What The Graph does here:

- **Indexes an event-less anchor surface.** Call handlers turn raw
  transaction calldata into a queryable, ordered anchor log — no events, no
  contract changes, no cooperation from the deployer needed.
- **Serves it from a decentralized network.** The subgraph is published on
  The Graph's decentralized network (Arbitrum One); serving indexers put GRT
  stake behind their responses.
- **Makes every response attributable.** The EIP-712 attestation binds each
  response to a staked allocation. A wrong answer is provably *that
  indexer's* wrong answer, and disputable on-chain. This is attribution, not
  validation.

What The Graph does **not** do here:

- **It adds no privacy.** The bond's confidentiality comes entirely from the
  PoC's own design. The Graph indexes public chain state; everything the
  subgraph serves is already public on Sepolia.
- **Attestations are signatures, not validity proofs.** They make an answer
  non-repudiable, never correct. Correctness is checked against the chain,
  by you.
- **Completeness is with respect to what the chain records — here, storage and
  transaction calldata (this contract emits no events) — never off-chain
  reality.** A record the issuer never anchored is invisible to every check on
  this page. This is not, and cannot be turned into, a proof of reserves; the
  off-chain cash legs are outside all claims.
- **Read privacy does not exist on this path.** The gateway and the serving
  indexer see which deployment you audit, your full query text, and when. An
  audit run reveals its own target.

## Reproduce it yourself — on the network

This is the verify-only path: you check the canonical deployment; you deploy
nothing and spend nothing on-chain. You need the
[code repository](https://github.com/p-diogo/graph-privacy-showcase-demos), a
Rust toolchain, `jq`, [Foundry](https://getfoundry.sh)'s `cast` (for the
direct chain checks), a Sepolia RPC URL of your own, and an API key created
in [Subgraph Studio](https://thegraph.com/studio/apikeys/).

Canonical values (address book of record: `deploy/canonical.json` in the
repository):

| | |
|---|---|
| Subgraph deployment id | `QmdfH3RytY2t5arbFehPmL4wyzejRaRVmN5PyhyKVJPiaz` |
| Subgraph id (Explorer) | `6Jq7LpWsX2CdNBJsBU4tiK4y21SDn5E3uUnLzNkNsUR1` |
| PrivateBond (Sepolia) | `0x0262b19FF2Fe455f43750442e7B32072D87059b1` |
| Network subgraph id (Arbitrum One) | `DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp` |
| DisputeManager (attestation domain) | `0x2FE023a575449AcB698648eD21276293Fa176f96` |

Build the CLI and set the values (run from
`items/01-private-bond-replay/src/replay` in the repository):

```bash
cargo build --release
mkdir -p ../../build

DEPLOYMENT=QmdfH3RytY2t5arbFehPmL4wyzejRaRVmN5PyhyKVJPiaz
BOND=0x0262b19FF2Fe455f43750442e7B32072D87059b1
NETWORK_SUBGRAPH_ID=DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp
DISPUTE_MANAGER=0x2FE023a575449AcB698648eD21276293Fa176f96
export GRAPH_API_KEY=…   # from Subgraph Studio; environment only
```

Fetch the attested anchor set through the gateway:

```bash
./target/release/bond-replay fetch \
  --gateway https://gateway.thegraph.com \
  --deployment "$DEPLOYMENT" \
  --out ../../build/audit-bundle.json
```

Without a pin, `fetch` resolves the head block, so two runs are not
byte-comparable — honest indexers legitimately differ by head drift. To re-run
this audit reproducibly, pass `--block-number` with the block your first bundle
recorded; the same pin makes every later comparison exact.

Verify the attestation offline and resolve the signer:

```bash
./target/release/bond-replay verify-attestation \
  --bundle ../../build/audit-bundle.json \
  --dispute-manager "$DISPUTE_MANAGER" \
  --network-subgraph "https://gateway.thegraph.com/api/$GRAPH_API_KEY/subgraphs/id/$NETWORK_SUBGRAPH_ID"
```

Two notes on that command. The API key sits in the `--network-subgraph` URL
path because that is the only channel this CLI has for it today — its
network-subgraph lookup sends no `Authorization` header, unlike the `fetch`
path above, which takes the key from the environment and sends it as a bearer
token. Keys in URLs land in shell history and proxy logs, so treat that URL as
a secret for as long as the key is live.

`--dispute-manager` must be passed explicitly for now: the attestation
domain's `verifyingContract` is the *current* DisputeManager on Arbitrum One,
and under a stale address recovery yields a well-formed but meaningless
signer. If it ever moves again, re-discover it from the network subgraph
(`graphNetwork(id: 1) { disputeManager }`) rather than trusting any page —
including this one.

Reconcile the disclosed records against the served anchors and the chain:

```bash
./target/release/bond-replay reconcile \
  --bundle ../../build/audit-bundle.json \
  --manifest ../../deploy/artifacts/records-manifest.json \
  --records-dir ../../deploy/artifacts/records \
  --rpc-url <your Sepolia RPC> --contract "$BOND" \
  --dispute-manager "$DISPUTE_MANAGER" \
  --verify-onchain
```

Expect every table green and exit 0. Then break it on purpose:

```bash
./target/release/bond-replay tamper --tripwire altered-record \
  --record bond_investor-a_2000001.json --field value \
  --bundle ../../build/audit-bundle.json \
  --manifest ../../deploy/artifacts/records-manifest.json \
  --records-dir ../../deploy/artifacts/records \
  --rpc-url <your Sepolia RPC> --contract "$BOND"
```

And check the chain directly, with no component from The Graph in the trust path:

```bash
cast call 0x0262b19FF2Fe455f43750442e7B32072D87059b1 "bondId()(bytes32)" \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
cast call 0x0262b19FF2Fe455f43750442e7B32072D87059b1 "knownRoots(bytes32)(bool)" \
  0x243a1d9096387fadfabf72873f8ad95027ce91996125958d2270074d7956850d \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com   # → true
```

Expected as of this page's 2026-07-29 status line: all checks pass, and the
attestation signer resolves to the single indexer serving this deployment. That
is attribution working, not independence demonstrated (see the limits below).

The deep-audit path — rebuild the entire stack from zero on your own machine,
local chain, local graph-node, tamper demos included — is the repository's
`REPRODUCE.md`, Mode B. It exists so that nothing on this page has to be
taken on trust.

## Honest limits

- **MockVerifier.** The canonical deployment uses the PoC's own
  `MockVerifier` (their test configuration), which accepts any proof. This
  deployment is **not** evidence that the PoC's zero-knowledge layer works,
  and claims nothing about it. The audit-read demonstration does not depend
  on proof validity: anchors land in storage and calldata either way.
- **Demo-grade, fictional data.** The bond, its records, and its parties are
  fictional throughout. No product claims: no SLA, no certification.
- **One serving indexer today.** Call handlers read execution traces, so
  serving this subgraph needs an indexer running an archive node with trace
  support. More can be drawn in by curating the subgraph with GRT, which we
  have not done — for a demonstration, one indexer serving attested responses
  is enough. The bar for *independent* serving is two unrelated staked
  indexers; until then `bond-replay consistency --min-signers 2`
  (cross-indexer agreement on identical pinned queries) cannot pass, and no
  single-signer run is presented as coverage.
- **Completeness ≠ reality.** Every check is against what was anchored
  on-chain. Nothing here proves the anchored set reflects off-chain reality.
- **Read privacy is absent.** The query patterns of an audit leak to the
  gateway and serving indexer, and the audit target is exactly the thing
  leaked. A separate service design addresses this; nothing on this page
  mitigates it today.

## Links

- Subgraph on The Graph Explorer: [private-bond-anchors-sepolia](https://thegraph.com/explorer/subgraphs/6Jq7LpWsX2CdNBJsBU4tiK4y21SDn5E3uUnLzNkNsUR1)
- Contracts on Sepolia (source-verified on Etherscan):
  [PrivateBond](https://sepolia.etherscan.io/address/0x0262b19FF2Fe455f43750442e7B32072D87059b1) ·
  [MockVerifier](https://sepolia.etherscan.io/address/0xA89d708F1114f00eE4A0228a745Ef792D18ec49D)
- Code: [graph-privacy-showcase-demos](https://github.com/p-diogo/graph-privacy-showcase-demos)
- EthSystems: [Institutional Privacy Map](https://github.com/ethsystems/map) ·
  [PoCs repository](https://github.com/ethsystems/pocs) (private-bond PoC, deployed unmodified at pin `94f1e5c`) ·
  [the pattern this executes](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-l2-encrypted-offchain-audit.md) ·
  [the use-case](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/use-cases/private-bonds.md)
- **Check this deployment live, in your browser:** [▶ the verification page](./verify.html#bond) — reads the anchored commitments and roots straight from Sepolia, no API key, nothing from The Graph in the trust path
- All demonstrations in this program: [the matrix](./matrix.md)
