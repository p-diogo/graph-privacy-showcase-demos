# Graph Privacy Showcase — canonical demos

Working proof-of-concepts showing that **The Graph serves the read and audit
path for confidential systems on public Ethereum**: complete, ordered,
independently re-derivable anchor logs, served from indexed chain state, with
every served response signed by an indexer that has GRT stake behind it.

Everything here runs against live contracts on Ethereum Sepolia and subgraphs
published to The Graph's decentralized network. You can verify all of it
yourself without deploying anything or spending anything on-chain.

---

## The gap this answers

When an institution puts a confidential instrument on a public chain, the
record content stays off-chain and the chain carries only cryptographic
anchors — commitments, nullifiers, Merkle roots. That keeps positions private,
and it creates an obligation the moment an auditor arrives: **someone has to
serve the complete anchored record**, so the records the institution chooses to
disclose can be checked against everything that was actually anchored. In
order, nothing missing, nothing rewritten.

[**EthSystems**](https://ethsystems.org) ([github.com/ethsystems](https://github.com/ethsystems))
is the company that catalogues this world. It began as the Ethereum
Foundation's Institutional Privacy Task Force and spun out in July 2026, and it
maintains the [**Institutional Privacy Map**](https://github.com/ethsystems/map)
— roughly 23 use-cases, 70 patterns, 25 vendors and 7 open RFPs for
confidential, compliant systems on public Ethereum, each scored for
censorship-resistance, openness, privacy and security. It also publishes
[open-source proof-of-concepts](https://github.com/ethsystems/pocs) for private
bonds, shielded stablecoin transfers, private settlement and more.

The map is a catalogue of confidential **execution**. Its disclosure-side
patterns all presuppose a **read** leg that nobody names. Their encrypted
off-chain audit pattern, for instance, ends by instructing the auditor to
*"replay the log against the anchored roots to confirm that no record has been
rewritten after the fact"* — without naming what serves the log being replayed.

That is the leg these demos build, on their artifacts rather than a stand-in.

---

## Who is in these scenarios

**Private-bond audit replay** — an **issuer** issues a confidential bond; note
values, owners and amounts never touch the chain, only Poseidon commitments and
Merkle roots do. **Investors** hold notes that move by transfer, swap and burn.
Months later an **auditor or regulator** arrives, receives a disclosed set of
records from the issuer, and has to establish that those records match the
complete anchor history — and that the party serving that history cannot lie
about it undetected. This demo is that auditor's tooling.

**Encrypted anchor stream** — a **record-keeper** (a bank's compliance log, an
audit trail, a transaction ledger) encrypts records client-side and anchors
only their ciphertext digests on-chain, so the log becomes tamper-evident
without revealing anything. A **verifier** later receives a disclosure and must
establish that it reconciles against the complete anchored stream: nothing
restated, nothing withheld, no gaps, no broken chain. This demo is that
verifier's tooling.

In both cases The Graph's role is narrow and stated precisely: it indexes
public chain state and serves it accountably. **It adds no confidentiality of
its own** — that belongs to the encryption and the commitment scheme.

---

## What is here, and what is coming

| # | Demonstration | Answers, from the map | Status |
|---|---|---|---|
| **01** | **Private-bond audit replay** — EthSystems' own private-bond PoC deployed unmodified, its full anchor surface indexed, and a `bond-replay` auditor CLI that verifies attestations offline and replays disclosed records against the anchored roots | [private-bonds use-case](https://github.com/ethsystems/map/blob/master/use-cases/private-bonds.md), [encrypted off-chain audit pattern](https://github.com/ethsystems/map/blob/master/patterns/pattern-l2-encrypted-offchain-audit.md) | **live** |
| **02** | **Encrypted anchor stream** — client-side-encrypted records anchored as pure calldata to a no-op contract, indexed into existence/ordering/completeness, with a `completeness-checker` that fails loudly and by name on each way a disclosure can lie | [encrypted off-chain audit](https://github.com/ethsystems/map/blob/master/patterns/pattern-l2-encrypted-offchain-audit.md), [compliance monitoring](https://github.com/ethsystems/map/blob/master/patterns/pattern-compliance-monitoring.md) | **live** |
| 03 | Verifiable extraction — re-executing chain data and verifying the extraction itself, not just the index | reproducible audit extraction | specified, not built |
| 04 | Shielded-pool public-surface monitor — indexing what confidential execution unavoidably leaves public | [private stablecoins](https://github.com/ethsystems/map/blob/master/use-cases/private-stablecoins.md), shielding patterns | specified, not built |
| 05 | Registry integrity view — tamper-evident change history for a statutory registry | [private registry](https://github.com/ethsystems/map/blob/master/use-cases/private-registry.md) | specified, not built |
| 06 | Private reads — a service design for the one thing these demos honestly cannot do today (see *Honest limits*) | [private-read use-case](https://github.com/ethsystems/map/blob/master/use-cases/private-read.md), their open RFP | design only, nothing shipped |

Items 03–06 are specified and independently reviewed, not built. Nothing in
this repository claims otherwise, and nothing appears here until it runs.

**Read the demonstrations in full:**
[the matrix](docs/matrix.md) (every item against the map artifacts it answers) ·
[private-bond audit replay](docs/private-bond-audit-replay.md) ·
[encrypted anchor stream](docs/encrypted-anchor-stream.md). Each page walks the
design, states what The Graph does and does *not* do, and ends with a
runnable verification path and an honest-limits section.

---

## The canonical deployment

Both subgraphs are **published on The Graph's decentralized network** (Arbitrum
One) and serve attested responses through the gateway. All four contracts are
source-verified on Etherscan.

| Subgraph | What it indexes | Explorer |
|---|---|---|
| `private-bond-anchors-sepolia` | The anchor surface of EthSystems' private-bond PoC at pin `94f1e5c`: note commitments, claimed roots, nullifiers, lifecycle calls | [view](https://thegraph.com/explorer/subgraphs/6Jq7LpWsX2CdNBJsBU4tiK4y21SDn5E3uUnLzNkNsUR1) |
| `anchor-data-edge-sepolia` | Encrypted record anchors posted as pure calldata (GIP-0025 "Data Edge" shape): existence, ordering, completeness of ciphertext digests — plaintext never touches the chain | [view](https://thegraph.com/explorer/subgraphs/46mk4GwpMkQEsR5UG3mFwSmYVU7ii838cvQGNt5WEhFb) |

| Contract (Ethereum Sepolia) | Address |
|---|---|
| PrivateBond — EthSystems' PoC, unmodified | [`0x0262b19F…59b1`](https://sepolia.etherscan.io/address/0x0262b19FF2Fe455f43750442e7B32072D87059b1) |
| MockVerifier | [`0xA89d708F…c49D`](https://sepolia.etherscan.io/address/0xA89d708F1114f00eE4A0228a745Ef792D18ec49D) |
| AnchorDataEdge | [`0x88AE18d2…4Dcb`](https://sepolia.etherscan.io/address/0x88AE18d29C20267441C5393787f719fa3f334Dcb) |

Every id, address and count used anywhere in this repository is read from
[`deploy/canonical.json`](deploy/canonical.json), and every value in it was
copied from a confirmed on-chain or Studio result — never from a plan.

Both contracts **emit no events**. The data rides in storage writes and raw
transaction calldata, which is why the subgraphs use call handlers: indexers
extract the calldata from execution traces. That is the interesting part —
indexing a surface that conventional event-based tooling cannot see at all.

---

## Try it in thirty seconds — no key, no install

Open [**`docs/verify.html`**](docs/verify.html) in a browser. It talks to a
public Sepolia RPC directly and, in front of you, reads the bond's anchored
commitments and roots off the chain, rebuilds the encrypted anchor stream from
raw transaction calldata, and re-computes the hash chain that links it. Nothing
from The Graph is in that trust path — which is the point: everything these
demonstrations serve is meant to be re-derivable without them.

Or from a terminal, with the same public RPC:

```bash
# the bond contract answers directly — is this Merkle root one the bond anchored?
cast call 0x0262b19FF2Fe455f43750442e7B32072D87059b1 "knownRoots(bytes32)(bool)" \
  0x243a1d9096387fadfabf72873f8ad95027ce91996125958d2270074d7956850d \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com   # → true

# change one digit of the root and it answers false
```

**Querying the index itself needs a gateway API key** (free from
[Subgraph Studio](https://thegraph.com/studio/apikeys/)) — that is the
decentralized-network path, the one the CLIs use and the one that returns a
signed attestation with every response:

```bash
curl -s https://gateway.thegraph.com/api/deployments/id/QmWcifKxjEKSg1nVerGXjmF5jbydj4RKtQgVvvxJBFyVs6 \
  -H "authorization: Bearer $GRAPH_API_KEY" -H 'content-type: application/json' \
  -d '{"query":"{ streams { id anchorCount latestSeq headEnvelopeDigest } anchors(first:10, orderBy:seq){ seq ciphertextDigest txHash } }"}'
```

## Verify it properly

Each item's `REPRODUCE.md` has two paths. **Mode A** verifies the canonical
deployment above — you deploy nothing and spend nothing. **Mode B** rebuilds
the whole stack from zero on your own machine, tamper demonstrations included,
so nothing on any page has to be taken on trust.

- [`items/01-private-bond-replay/REPRODUCE.md`](items/01-private-bond-replay/REPRODUCE.md) —
  fetch the attested anchor set, verify the EIP-712 attestation offline and
  resolve its signer to a staked allocation, then replay the disclosed records
  against the roots the contract recorded on-chain. Then break it on purpose
  and watch it fail in a named place.
- [`items/02-encrypted-anchoring/REPRODUCE.md`](items/02-encrypted-anchoring/REPRODUCE.md) —
  reconcile a disclosure against the served index and against raw Sepolia
  blocks, with no component from The Graph in the trust path.

---

## Honest limits

- **Demo-grade, fictional data. Not a product.** No SLA, no certification, no
  uptime claim. The bond id `XF0000000001` is an ISIN-*format* string that
  cannot collide with a real security, and every record, party and amount is
  invented.
- **The bond PoC runs EthSystems' own `MockVerifier`** (their test
  configuration), which accepts any proof. This deployment is **not** evidence
  that their zero-knowledge layer works and claims nothing about it. The audit
  read path does not depend on proof validity: anchors land in storage and
  calldata either way.
- **Attestations are signatures, not validity proofs.** A signed response makes
  a wrong answer attributable to a staked party and disputable on-chain. It
  never makes the answer correct. Correctness is established by checking
  against the chain, by you.
- **Completeness is bounded by what the chain records** — storage and calldata
  here — never by off-chain reality. A record that was never anchored is
  invisible to every check in this repository. This is not a proof of reserves
  and cannot be turned into one.
- **Read privacy does not exist on this path.** Every query tells the gateway
  and the serving indexer which deployment you are auditing, the full query
  text, and when. An audit run reveals its own target. Item 06 is a design for
  fixing that; nothing here mitigates it today.
- **One serving indexer today.** Call handlers read execution traces, so
  serving these subgraphs needs an indexer running an archive node with trace
  support. More can be drawn in by curating the subgraphs with GRT, which has
  not been done — for a demonstration, one indexer serving attested responses
  is enough. The bar for *independent* serving is two unrelated staked
  indexers, and no single-signer run is presented as meeting it.
- **The `AnchorDataEdge` contract is permissionless** by design: anyone may
  post to any stream. The index reports what the chain contains, including
  conflicting and malformed posts; the checker adjudicates.
- **One gate:** item 02's checker reconciles a *disclosure* — plaintext records
  plus the stream key — and the canonical disclosure bundle is not published,
  because it contains that key. Everything else here is runnable by anyone
  today.

---

## Repository layout

- [`deploy/canonical.json`](deploy/canonical.json) — the address book of
  record; every path reads from it.
- `items/01-private-bond-replay/` — the `bond-replay` auditor CLI (Rust):
  attested fetch, offline EIP-712 verification with signer→stake resolution,
  disclosure reconciliation with on-chain root replay, and a tamper mode.
  `deploy/artifacts/` holds the disclosed record set and its manifest; `src/`
  holds the contracts, seed and subgraph sources.
- `items/02-encrypted-anchoring/` — the `anchor-writer` and
  `completeness-checker` CLIs (TypeScript): deterministic AES-256-GCM-SIV
  envelopes, disclosure reconciliation, and the raw-chain cross-check.
- `subgraphs/` — the two published subgraphs as deployed: schemas,
  call-handler manifests, mappings.

The EthSystems private-bond PoC is **not** vendored here. It is fetched from
[their repository](https://github.com/ethsystems/pocs) at the pinned commit by
a script, so their code stays theirs and stays verifiable against the source.

## Elsewhere

- [EthSystems Institutional Privacy Map](https://github.com/ethsystems/map) —
  the use-cases, patterns and RFPs these demonstrations answer
- [EthSystems PoCs](https://github.com/ethsystems/pocs) — the private-bond PoC
  deployed here, unmodified, at pin `94f1e5c`
- [GRC-0001 "Data Edge"](https://github.com/graphprotocol/graph-improvement-proposals/blob/master/grcs/0001-data-edge.md)
  — the calldata-anchoring shape item 02 follows, from The Graph's own ecosystem

Part of a broader programme mapping shipped capabilities of The Graph to
institutional privacy patterns. Questions and issues are welcome — a
reproduction that does not work is a finding we want.
