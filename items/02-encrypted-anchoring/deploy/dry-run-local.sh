#!/usr/bin/env bash
# Rehearse the entire canonical deploy kit against a local anvil chain.
#
# Same five scripts, same order, same signer code path, same on-chain
# assertions. Three things differ, each explicit rather than special-cased:
# EXPECTED_CHAIN_ID=31337, the stream keyfile lives in a temp directory instead
# of the owner's home, and the signer is generated here at runtime and funded
# from anvil — so no key material is committed, not even anvil's well-known
# account-0 key.
#
# Nothing here touches a public network. It spends nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITEM_ROOT="$(cd "$HERE/.." && pwd)"
PORT="${DRY_RUN_PORT:-18547}"
RPC="http://127.0.0.1:$PORT"
ANVIL_PID=""
CANON_DIR=""

cleanup() {
  [ -n "$ANVIL_PID" ] && { kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; }
  [ -n "$CANON_DIR" ] && rm -rf "$CANON_DIR"
}
trap cleanup EXIT

say() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "FATAL: something is already listening on $RPC" >&2
  echo "Stop it, or set DRY_RUN_PORT to a free port." >&2
  exit 1
fi

say "0 · prepare"
"$HERE/prepare.sh"

say "1 · start a throwaway chain on $PORT"
anvil --port "$PORT" --silent &
ANVIL_PID=$!
for _ in $(seq 1 50); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
cast block-number --rpc-url "$RPC" >/dev/null
echo "anvil up (pid $ANVIL_PID)"

say "2 · generate and fund a throwaway signer"
WALLET="$(cast wallet new --json)"
SIGNER_ADDRESS="$(echo "$WALLET" | jq -r '.[0].address')"
DEPLOYER_PRIVATE_KEY="$(echo "$WALLET" | jq -r '.[0].private_key')"
unset WALLET
cast rpc --rpc-url "$RPC" anvil_setBalance "$SIGNER_ADDRESS" 0x21e19e0c9bab2400000 >/dev/null
echo "signer $SIGNER_ADDRESS funded (key generated at runtime, never written to disk)"

# Outside the repository, which is what the scripts enforce.
CANON_DIR="$(mktemp -d "${TMPDIR:-/tmp}/item02-canonical-dryrun.XXXXXX")"
echo "canonical stream directory: $CANON_DIR (outside the repo, per _env.sh)"

export SEPOLIA_RPC_URL="$RPC"
export EXPECTED_CHAIN_ID=31337
export DEPLOYER_PRIVATE_KEY
export ANCHOR_KEYSTORE="$CANON_DIR/stream-keyfile.json"
export ANCHOR_ARCHIVE="$CANON_DIR/archive.json"
export ANCHOR_DISCLOSURE="$CANON_DIR/disclosure"
export ARTIFACT_DIR="${ARTIFACT_DIR:-$HERE/artifacts-dryrun}"
unset DEPLOYER_ACCOUNT || true
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"

say "3 · the key-location guard actually refuses"
if ANCHOR_KEYSTORE="$ITEM_ROOT/inside-the-repo.json" "$HERE/00-init-stream.sh" 2>/dev/null; then
  echo "FATAL: the guard let a keyfile inside the repository" >&2
  exit 1
fi
echo "refused a keyfile path inside the repository, as it must"

say "4 · 00-init-stream.sh"
"$HERE/00-init-stream.sh"

say "5 · 00-init-stream.sh is idempotent"
"$HERE/00-init-stream.sh" | grep -q "Not regenerating" ||
  { echo "FATAL: re-init did not refuse to mint a new streamId" >&2; exit 1; }
echo "second run refused to mint a new streamId"

say "6 · 01-deploy.sh"
"$HERE/01-deploy.sh"

say "7 · 02-seed-anchors.sh"
"$HERE/02-seed-anchors.sh"

say "8 · 03-verify-chain.sh"
"$HERE/03-verify-chain.sh"

say "9 · the tamper demos still bite on canonical-shaped data"
node "$ITEM_ROOT/dist/tools/tamper.js" alter --disclosure "$ANCHOR_DISCLOSURE" --out "$CANON_DIR/d-altered" --seq 3
if node "$ITEM_ROOT/dist/completeness-checker/cli.js" verify --disclosure "$CANON_DIR/d-altered" \
     --source chain --rpc "$RPC" >/dev/null 2>&1; then
  echo "FATAL: an altered disclosure passed" >&2; exit 1
fi
echo "an altered record still fails against the chain (exit non-zero)"

node "$ITEM_ROOT/dist/tools/tamper.js" suppress --disclosure "$ANCHOR_DISCLOSURE" --out "$CANON_DIR/d-suppressed" --seq 5
if node "$ITEM_ROOT/dist/completeness-checker/cli.js" verify --disclosure "$CANON_DIR/d-suppressed" \
     --source chain --rpc "$RPC" >/dev/null 2>&1; then
  echo "FATAL: a suppressed record passed" >&2; exit 1
fi
echo "a withheld record still fails against the chain (exit non-zero)"

say "10 · 04-render-manifest.sh"
CANONICAL_JSON=/nonexistent "$HERE/04-render-manifest.sh"
MANIFEST="$ITEM_ROOT/src/subgraph/subgraph.sepolia.yaml"
if ! grep -Eq "^ *network: '?sepolia'?" "$MANIFEST"; then
  echo "FATAL: rendered manifest is not on network sepolia" >&2; exit 1
fi
if grep -q "{{" "$MANIFEST"; then
  echo "FATAL: rendered manifest still has unreplaced placeholders" >&2; exit 1
fi
if grep -Eq "^ *startBlock: 0$" "$MANIFEST"; then
  echo "FATAL: startBlock is 0 — that would index from genesis" >&2; exit 1
fi
if ! grep -q "mapping.ts" "$MANIFEST"; then
  echo "FATAL: rendered manifest is not the honest variant" >&2; exit 1
fi
echo "manifest renders clean: network sepolia, honest mapping, startBlock pinned"

say "11 · gas actually used"
total=0
deploy_gas=$(( $(cast receipt "$(jq -r .deployTx "$ARTIFACT_DIR/deployment.json")" gasUsed --rpc-url "$RPC") ))
printf '  %-28s %10d\n' "AnchorDataEdge deploy" "$deploy_gas"
total=$((total + deploy_gas))
anchor_total=0
n=0
while read -r h; do
  g=$(( $(cast receipt "$h" gasUsed --rpc-url "$RPC") ))
  anchor_total=$((anchor_total + g))
  n=$((n + 1))
done < <(jq -r '.anchors[].txHash' "$ANCHOR_ARCHIVE")
printf '  %-28s %10d  (%d txs, mean %d)\n' "anchor posts" "$anchor_total" "$n" "$((anchor_total / n))"
total=$((total + anchor_total))
printf '  %-28s %10d\n' "TOTAL (excl. 2 edge cases)" "$total"
echo
echo "At 1.1 gwei that is $(awk -v g="$total" 'BEGIN{printf "%.6f", g*1.1/1e9}') ETH."
echo "At 55 gwei (observed Sepolia spike) it is $(awk -v g="$total" 'BEGIN{printf "%.4f", g*55/1e9}') ETH."

say "DRY RUN PASSED"
echo "The kit generated a stream key outside the repo, refused one inside it,"
echo "deployed, posted the canonical stream plus both awkward cases, reconciled"
echo "the disclosure against raw chain data, caught both disclosure tampers,"
echo "and rendered a sepolia manifest."
echo
echo "What this does NOT prove: anything about Sepolia, or about whether any"
echo "network indexer will serve a call-handler subgraph there."
