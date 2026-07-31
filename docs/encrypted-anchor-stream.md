# Encrypted anchor stream

*A live demonstration that client-side-encrypted records, anchored on public
Ethereum as nothing but calldata, are indexable as a complete, ordered,
independently re-derivable stream — existence, ordering, completeness, without
plaintext.
Contract on Ethereum Sepolia; subgraph published to The Graph's decentralized
network. Status as of 2026-07-29.*

## What this is

Institutions that keep sensitive records off-chain — compliance logs, audit
trails, transaction records — anchor them on-chain so they become
tamper-evident: each record's ciphertext is hashed, and the hash is posted to
a public chain the record-keeper cannot rewrite. The
[EthSystems Institutional Privacy Map](https://github.com/ethsystems/map)
describes this in its
[encrypted off-chain audit](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-l2-encrypted-offchain-audit.md)
and
[compliance monitoring](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-compliance-monitoring.md)
patterns: anchored logs are the substrate disclosures and screening workflows
are checked against. Both patterns presuppose an unnamed serving leg — a
party who serves the *complete, ordered* anchor set to the verifier, and whom
the verifier does not have to take on faith.

This PoC builds that leg and makes it checkable. An anchor-writer CLI
encrypts ten fictional records client-side and posts their digests to a no-op
contract on Sepolia — the anchors exist only as transaction calldata; the
contract stores nothing and emits nothing. A call-handler subgraph, published
to The Graph's decentralized network, decodes those transactions into an
index of existence, ordering, and completeness. A completeness checker then
reconciles a disclosure (plaintext records plus the stream key) against the
served index and against raw Sepolia blocks — and fails loudly, with a named
finding, when a record is restated, a record is withheld, a server withholds
anchors, or the hash chain breaks.

The contract follows the "Data Edge" shape from The Graph's own ecosystem
(GIP-0025, catalogued as
[GRC-0001](https://github.com/graphprotocol/graph-improvement-proposals/blob/9df2b290c2b1e05546bf5c5578527341e3c079aa/grcs/0001-data-edge.md)):
meaning lives entirely in calldata, and a subgraph gives it structure. The
problem statement is EthSystems'; the anchoring pattern precedent is The
Graph's; the code here is ours.

## How it works

**The contract is deliberately almost nothing.**

```solidity
contract AnchorDataEdge {
    function postAnchor(bytes calldata) external {
        // no-op
    }
}
```

No storage, no events, no owner. It is permissionless by design: anyone may
post to any stream, and the index reports what the chain contains — the
verification tooling adjudicates.

**The envelope.** Each anchor is a fixed 105-byte payload: a version byte, a
random 32-byte stream id, a big-endian sequence number (contiguous from 0), a
`keccak256` digest of the record's *ciphertext*, and a `keccak256` digest of
the previous anchor's full envelope. That last field hash-chains the stream:
suppressing, reordering, or forging a middle anchor breaks both sequence
contiguity and the chain. Digests are of ciphertext, never plaintext —
nothing about record content is derivable on-chain.

**Deterministic encryption, so a disclosure is checkable.** Records are
encrypted client-side with AES-256-GCM-SIV, with the per-record nonce and key
derived via HKDF from the stream key, and the stream id and sequence number
bound into the additional authenticated data. Determinism is the point:
plaintext plus stream key reproduce every ciphertext byte-for-byte, so a
verifier can recompute the entire expected anchor sequence from a disclosure
alone — no ciphertext archive needed. A ciphertext transplanted to another
position fails authentication.

**The subgraph indexes pure calldata.** A call handler on `postAnchor(bytes)`
fires on every matching transaction (indexers extract calldata from execution
traces, since there are no events to filter on) and decodes the envelope with
fixed-offset reads. The index keeps honest-completeness rules: a well-formed
first occurrence of a (stream, seq) pair becomes an `Anchor`; an identical
re-submission increments a duplicate counter; a *different* envelope at an
existing seq becomes a `ConflictingAnchor` and flags the stream; an
undecodable payload becomes a `MalformedAnchor` with its raw bytes. Nothing
is silently dropped. The canonical stream makes this visible on purpose: 10
anchors (seq 0–9) plus one deliberate junk payload and one deliberate
re-submission, both publicly reported by the index as notes, not hidden.

**The checker closes the loop.** `completeness-checker verify` recomputes the
expected sequence from the disclosure, fetches the served index (through the
gateway, from a local graph-node, or — with no component from The Graph in the trust
path at all — rebuilt from raw Sepolia blocks), and compares. Every verdict
is specific and carries its own exit code:

| Lie | Finding |
|---|---|
| A disclosed record was restated after anchoring | `ALTERED seq=k` — its recomputed digest no longer matches the anchor |
| A record was withheld from the disclosure | `MISSING seq=k` plus a count mismatch — the chain anchors something the disclosure omits |
| A server withholds anchors | `GAP seq=k` — the served index lacks an anchor the raw chain has |
| A server (or forger) breaks the sequence | `CHAIN-BREAK seq=k` — the envelope hash chain no longer connects |
| A third party posts a different envelope at an existing seq | `CONFLICT` — possible on a permissionless contract, and reported as exactly what it is |

The direction of trust is stated in the tool's output: the on-chain anchor
set is the reference, and disclosures are checked against it.

## The Graph's role, precisely

What The Graph does here:

- **Indexes anchors that exist only as calldata.** No events, no storage —
  call handlers over execution traces are what turn a no-op contract's
  transaction stream into a queryable index. This is the same mechanism
  The Graph's own Epoch Block Oracle uses in production on Ethereum mainnet.
- **Serves the index from a decentralized network** of GRT-staked indexers,
  with each paid gateway response carrying an EIP-712 attestation
  (`graph-attestation` header) binding request, response, and deployment to
  the indexer's staked allocation — so a wrong answer is attributable and
  disputable. Attribution, not validation.
- **Keeps the index re-derivable.** Anyone can rebuild the same anchor set
  from raw Sepolia blocks and compare, entity for entity. The checker does
  exactly that in its chain cross-check mode.

What The Graph does **not** do here:

- **It adds no privacy.** Confidentiality comes from client-side encryption;
  keys never appear on-chain or in the subgraph. The Graph indexes public
  chain state — the digests were public the moment they were posted.
- **Attestations are signatures, not validity proofs.** They never make an
  answer correct; correctness is checked against the chain, by you.
- **Completeness is with respect to what the chain records — here, transaction
  calldata — never off-chain reality.** The checker establishes that the
  disclosed records are exactly what was anchored; it says nothing about
  whether the anchored set reflects the world. This is not a proof of
  reserves and cannot be turned into one.
- **Read privacy does not exist on this path.** Every query tells the
  gateway and the serving indexer which stream you are auditing, and when.

## Reproduce it yourself — on the network

This is the verify-only path against the canonical deployment: you deploy
nothing and post nothing. You need the
[code repository](https://github.com/p-diogo/graph-privacy-showcase-demos),
Node 22 with pnpm, `jq` and `curl`, [Foundry](https://getfoundry.sh)'s `cast`
(for the raw-calldata check below), a Sepolia **archive** RPC URL of your own,
and an API key created in
[Subgraph Studio](https://thegraph.com/studio/apikeys/).

Canonical values (address book of record: `deploy/canonical.json` in the
repository):

| | |
|---|---|
| Subgraph deployment id | `QmWcifKxjEKSg1nVerGXjmF5jbydj4RKtQgVvvxJBFyVs6` |
| Subgraph id (Explorer) | `46mk4GwpMkQEsR5UG3mFwSmYVU7ii838cvQGNt5WEhFb` |
| AnchorDataEdge (Sepolia) | `0x88AE18d29C20267441C5393787f719fa3f334Dcb` |
| Canonical stream id | `0x0c0bf6a287a135b35900881fe941de67087970677cb4153c8d02961c9970e1ef` |

**One gate, stated plainly:** the checker reconciles a *disclosure* —
plaintext records plus the stream key — and the canonical disclosure bundle
is not yet published (it contains the stream key; once it is public, anyone
can post conflicting anchors at existing seqs, which the checker reports as
`CONFLICT` — the tool working, not the demo breaking). Until that publish
decision, the checker's reconciliation steps run only with a bundle obtained
from us; everything else on this page is runnable by anyone today.

Query the served index directly (the subgraph's Explorer page also has a
zero-setup playground):

```bash
curl -s https://gateway.thegraph.com/api/deployments/id/QmWcifKxjEKSg1nVerGXjmF5jbydj4RKtQgVvvxJBFyVs6 \
  -H "authorization: Bearer $GRAPH_API_KEY" -H 'content-type: application/json' \
  -d '{"query":"{ streams { id anchorCount latestSeq headEnvelopeDigest hasConflicts } anchors(first:10, orderBy:seq){ seq ciphertextDigest prevEnvelopeDigest txHash } malformedAnchors { txHash } }"}'
```

Expect 1 stream, 10 anchors at seq 0–9, one malformed anchor and a duplicate
count — exactly as seeded. Every served anchor names its `txHash`; for any
one of them, `cast tx <txHash> input --rpc-url <your Sepolia RPC>` returns
the raw calldata whose bytes after the 68-byte ABI header are exactly the
105-byte envelope the index decoded. The index adds structure, never facts.

Build the checker and pin a block (run from `items/02-encrypted-anchoring` in
the repository; unpinned gateway runs are not reproducible, so every run
below passes `--block`):

```bash
pnpm install && pnpm build

DEPLOYMENT=QmWcifKxjEKSg1nVerGXjmF5jbydj4RKtQgVvvxJBFyVs6
export GRAPH_API_KEY=…   # from Subgraph Studio; environment only
DISCLOSURE=…             # path to the disclosure bundle (see the gate above)

BLOCK=$(curl -s "https://gateway.thegraph.com/api/deployments/id/$DEPLOYMENT" \
  -H "authorization: Bearer $GRAPH_API_KEY" -H 'content-type: application/json' \
  -d '{"query":"{_meta{block{number}}}"}' | jq -r .data._meta.block.number)
```

Reconcile through the gateway, capturing the attestation:

```bash
node dist/completeness-checker/cli.js verify --disclosure "$DISCLOSURE" \
  --source gateway \
  --url "https://gateway.thegraph.com/api/deployments/id/$DEPLOYMENT" \
  --api-key "$GRAPH_API_KEY" \
  --block "$BLOCK" \
  --evidence .local/attestations
```

Expect exit 0, with two notes and no findings: the seeded re-submission as
`DUPLICATE` and the seeded junk payload as `MALFORMED`.

Cross-check against raw chain data — no component from The Graph in the trust path —
and then both sources against each other:

```bash
node dist/completeness-checker/cli.js verify --disclosure "$DISCLOSURE" \
  --source chain --rpc <your Sepolia archive RPC> --to-block "$BLOCK"

node dist/completeness-checker/cli.js verify --disclosure "$DISCLOSURE" \
  --source gateway \
  --url "https://gateway.thegraph.com/api/deployments/id/$DEPLOYMENT" \
  --api-key "$GRAPH_API_KEY" --block "$BLOCK" \
  --cross-check-chain --rpc <your Sepolia archive RPC> --to-block "$BLOCK"
```

The captured `graph-attestation` can be verified deeply — signature recovery
under the current DisputeManager domain, signer resolved to a staked
allocation — with the `bond-replay` CLI from the
[private-bond audit replay](./private-bond-audit-replay.md) demonstration,
which owns that step; this checker records attestations rather than
re-implementing the verification.

The deep-audit path — rebuild everything from zero locally, including the
dishonest-server fixtures that trigger `GAP` and `CHAIN-BREAK` — is the
repository's `REPRODUCE.md`, Mode B.

## Honest limits

- **Demo-grade, fictional data.** Ten fictional records, demo key
  management (a local keyfile — no custody or KMS guidance implied). No
  product claims.
- **The disclosure bundle is not yet public** (see the gate above), so the
  checker's reconciliation steps are not yet stranger-runnable end to end;
  the served index, the raw-chain cross-check of it, and the attestation
  capture are.
- **One serving indexer today.** Call handlers read execution traces, so
  serving this subgraph needs an indexer running an archive node with trace
  support. More can be drawn in by curating the subgraph with GRT, which we
  have not done — for a demonstration, one indexer serving attested responses
  is enough. The bar for *independent* serving is two unrelated staked
  indexers, and no single-signer run is presented as meeting it.
- **Anchoring publishes metadata by design.** Existence, count, cadence,
  writer address, and stream id are public forever. No timing-privacy claim
  is made; batching and padding are noted as deployer options, not
  implemented here.
- **Completeness ≠ reality.** The checker establishes disclosure ↔ anchors,
  never anchors ↔ world. No proof-of-reserves framing, anywhere.
- **Read privacy is absent.** Queries leak the audit target and its timing
  to whoever serves them.

## Links

- Subgraph on The Graph Explorer: [anchor-data-edge-sepolia](https://thegraph.com/explorer/subgraphs/46mk4GwpMkQEsR5UG3mFwSmYVU7ii838cvQGNt5WEhFb)
- Contract on Sepolia (source-verified on Etherscan):
  [AnchorDataEdge](https://sepolia.etherscan.io/address/0x88AE18d29C20267441C5393787f719fa3f334Dcb)
- Code: [graph-privacy-showcase-demos](https://github.com/p-diogo/graph-privacy-showcase-demos)
- EthSystems map artifacts this answers:
  [pattern-l2-encrypted-offchain-audit](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-l2-encrypted-offchain-audit.md) ·
  [pattern-compliance-monitoring](https://github.com/ethsystems/map/blob/3bca7a15d454c53275264d687bb8879130d62ef2/patterns/pattern-compliance-monitoring.md)
- The anchoring shape: [GRC-0001 "Data Edge"](https://github.com/graphprotocol/graph-improvement-proposals/blob/9df2b290c2b1e05546bf5c5578527341e3c079aa/grcs/0001-data-edge.md) ·
  [GIP-0025 forum thread](https://forum.thegraph.com/t/gip-0025-dataedge/3161)
- **Check this stream live, in your browser:** [▶ the verification page](./verify.html#anchors) — rebuilds all ten anchors from raw calldata and re-computes the hash chain, no API key, nothing from The Graph in the trust path
- All demonstrations in this program: [the matrix](./matrix.md)
