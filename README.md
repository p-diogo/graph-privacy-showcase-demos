# Graph Privacy Showcase — Canonical Demos (Ethereum Sepolia)

Two live subgraphs demonstrating The Graph as the **read and audit path** for
confidential systems on public Ethereum: complete, independently re-derivable
anchor logs served from indexed chain state. Both index contracts that emit
**no events** — the data rides in storage writes and raw calldata, captured via
call handlers.

Both are **published on The Graph's decentralized network** (Arbitrum One) and
serve attested responses through the gateway:
[Private Bond Anchors](https://thegraph.com/explorer/subgraphs/6Jq7LpWsX2CdNBJsBU4tiK4y21SDn5E3uUnLzNkNsUR1) ·
[Encrypted Anchor Stream](https://thegraph.com/explorer/subgraphs/46mk4GwpMkQEsR5UG3mFwSmYVU7ii838cvQGNt5WEhFb).
All four contracts are source-verified on Etherscan.

| Subgraph | What it indexes | Deployment ID |
|---|---|---|
| `private-bond-anchors-sepolia` | The anchor surface of [EthSystems' open-source private-bond PoC](https://github.com/ethsystems/pocs) (deployed unmodified at pin `94f1e5c`): note commitments, Merkle roots, nullifiers | `QmdfH3RytY2t5arbFehPmL4wyzejRaRVmN5PyhyKVJPiaz` |
| `anchor-data-edge-sepolia` | Client-side-encrypted record anchors posted as pure calldata to a Data Edge-style no-op contract (GIP-0025 shape): existence, ordering, completeness of ciphertext digests — plaintext never touches the chain | `QmWcifKxjEKSg1nVerGXjmF5jbydj4RKtQgVvvxJBFyVs6` |

## Canonical contracts (Ethereum Sepolia)

| Contract | Address |
|---|---|
| PrivateBond (EthSystems PoC, unmodified) | [`0x0262b19FF2Fe455f43750442e7B32072D87059b1`](https://sepolia.etherscan.io/address/0x0262b19FF2Fe455f43750442e7B32072D87059b1) |
| MockVerifier | [`0xA89d708F1114f00eE4A0228a745Ef792D18ec49D`](https://sepolia.etherscan.io/address/0xA89d708F1114f00eE4A0228a745Ef792D18ec49D) |
| AnchorDataEdge | [`0x88AE18d29C20267441C5393787f719fa3f334Dcb`](https://sepolia.etherscan.io/address/0x88AE18d29C20267441C5393787f719fa3f334Dcb) |

## Try it

```bash
curl -s https://api.studio.thegraph.com/query/1714091/anchor-data-edge-sepolia/v0.1.0 \
  -H 'content-type: application/json' \
  -d '{"query":"{ streams { id anchorCount latestSeq headEnvelopeDigest } anchors(first:10, orderBy:seq){ seq ciphertextDigest txHash } }"}'
```

Cross-check the index against the chain directly — the point of the exercise:

```bash
cast call 0x0262b19FF2Fe455f43750442e7B32072D87059b1 "knownRoots(bytes32)(bool)" \
  0x243a1d9096387fadfabf72873f8ad95027ce91996125958d2270074d7956850d \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com   # → true
```

## What this is, honestly

- **Demo-grade, fictional data.** The bond id is `XF0000000001` — an
  ISIN-*format* string that cannot collide with a real security. The bond PoC
  is deployed with EthSystems' own `MockVerifier` (their test configuration):
  this deployment is **not** evidence that the PoC's ZK layer works, and
  claims nothing about it.
- **What it does demonstrate:** indexing of event-less contracts via call
  handlers; complete anchor logs (existence, ordering, completeness — including
  indexed *malformed* and *duplicate* posts, reported rather than dropped);
  and reconciliation of every served fact against raw chain data anyone can
  fetch themselves.
- **No privacy claims.** The Graph indexes public chain state; ciphertext
  digests are public. Confidentiality belongs to the encryption client-side;
  keys never appear on-chain or in these subgraphs.
- The `AnchorDataEdge` contract is permissionless: anyone may post to any
  stream. The index reports what the chain contains; verification tooling
  adjudicates.

## Contents

- `subgraphs/private-bond-anchors/` — schema, call-handler manifest
  (mustache-templated + rendered Sepolia manifest), mappings.
- `subgraphs/anchor-data-edge/` — same shape; the 105-byte envelope decoder
  lives in `src/anchor.ts`.

Part of a broader program by The Graph community mapping shipped Graph
capabilities to institutional privacy patterns. Questions/issues welcome.
