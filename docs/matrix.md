# Demonstration matrix

*A mapping from EthSystems' Institutional Privacy Map to the proof-of-concepts
this program builds. Each row names the map artifacts we answer, what we built,
the current status, and where to read the detail. Status as of 2026-07-30.*

**What these are.** Demo-grade evidence on fictional data, not product: no SLA,
no certification, nothing here is a production service. The Graph indexes public
chain state and adds no confidentiality of its own; read privacy does not exist
on any of these paths. Every claim on every linked page is backed by an artifact
someone re-ran, or is labelled as not yet run.

> ### ▶ Check any of this yourself, live
>
> **[Open the verification page](./verify.html)** — it reads the bond's anchored
> commitments and roots straight off Ethereum Sepolia in your browser, and rebuilds
> the encrypted anchor stream from raw transaction calldata. No API key, no install,
> and nothing from The Graph in the trust path. Everything below is meant to be
> re-derivable without us; that page is where you re-derive it.

## The matrix

| Item | EthSystems artifact(s) it answers | What we built | Status | Read | Verify live |
|---|---|---|---|---|---|
| 01 | [use-cases/private-bonds.md](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/use-cases/private-bonds.md) · [pattern-l2-encrypted-offchain-audit](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-l2-encrypted-offchain-audit.md) · [pattern-reproducible-audit-extraction (ours, staged for contribution on our fork, not yet theirs)](https://github.com/graphprotocol/map/blob/feat/vendor-the-graph/patterns/pattern-reproducible-audit-extraction.md) | EthSystems' private-bond PoC (deployed unmodified at pin `94f1e5c`) on Ethereum Sepolia; subgraph via call handlers; `bond-replay` auditor CLI with EIP-712 attestation verification and root reconciliation | live — single indexer | [Private-bond audit replay](./private-bond-audit-replay.md) | **[▶ check the bond](./verify.html#bond)** |
| 02 | [pattern-l2-encrypted-offchain-audit](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-l2-encrypted-offchain-audit.md) · [pattern-compliance-monitoring](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-compliance-monitoring.md) | `AnchorDataEdge` no-op contract (pure-calldata anchoring); subgraph via call handlers; `completeness-checker` CLI with disclosure reconciliation and chain cross-check | live — single indexer | [Encrypted anchor stream](./encrypted-anchor-stream.md) | **[▶ rebuild the stream](./verify.html#anchors)** |
| 03 | [pattern-reproducible-audit-extraction (ours, staged for contribution on our fork, not yet theirs)](https://github.com/graphprotocol/map/blob/feat/vendor-the-graph/patterns/pattern-reproducible-audit-extraction.md) (verify-the-extraction leg) | Spec verified: Firehose-powered re-execution test with veemon verification; mainnet fixtures, then Sepolia testnet | spec-only | No page yet — spec held in the program repo, not public | — |
| 04 | [use-cases/private-stablecoins.md](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/use-cases/private-stablecoins.md) · the shielding pattern family ([pattern-shielding](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-shielding.md), [pattern-private-stablecoin-shielded-payments](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-private-stablecoin-shielded-payments.md)) · [pattern-compliance-monitoring](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-compliance-monitoring.md) | Spec verified: shielded-pool public-surface monitor; local + network POI cross-check | spec-only | No page yet — spec held in the program repo, not public | — |
| 05 | [use-cases/private-registry.md](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/use-cases/private-registry.md) (Problem 3) · [crypto-registry-bridge-ewpg-eas](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-crypto-registry-bridge-ewpg-eas.md) | Spec verified: registry integrity view (eWpG/MiCA statutory seam) | spec-only | No page yet — spec held in the program repo, not public | — |
| 06 | [use-cases/private-read.md](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/use-cases/private-read.md) · [pattern-private-information-retrieval](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-private-information-retrieval.md) · [rfp-private-reads](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/rfps/rfp-private-reads.md) | Spec verified: Private Reads service design (horizontal layer under items 01–05; L0 kit build pending) | spec-only | No page yet — spec held in the program repo, not public | — |
| — | (internal) | veemon fix branches on p-diogo/veemon fork | upstream fix branches | No page — code in https://github.com/p-diogo/veemon | — |

## How to read status

- **live — single indexer**: Contracts on Sepolia, subgraph published to the decentralized network and serving attested responses through the gateway. One indexer serves it today; two unrelated staked indexers is the bar for *independent* serving, and it is not met.
- **spec-only**: Design is frozen and verified; implementation is pending (tranche 2).
- **upstream fix branches**: Verified fixes to open-source tooling, unmerged. Not a deployment and not a service — anyone runs this tooling themselves.

Nothing here states what we have not run ourselves. The honesty rules that bind
every row — The Graph is a read and audit path, not a privacy technology;
attestations are signatures, not validity proofs; completeness is bounded by what
the chain records; read privacy does not exist today — are set out in full on
each page's *Honest limits* section.

## Links

- [EthSystems Institutional Privacy Map](https://github.com/ethsystems/map) — source use-cases, patterns, and RFPs
- [graph-privacy-showcase-demos](https://github.com/p-diogo/graph-privacy-showcase-demos) — the code: both auditor CLIs, the subgraph sources, the canonical address book, and each item's `REPRODUCE.md`
