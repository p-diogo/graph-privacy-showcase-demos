#!/usr/bin/env bash
# Rehearse the entire canonical deploy kit against a local anvil chain.
#
# The point is that the Sepolia scripts are not untested paper: this runs the
# same four scripts, in the same order, with the same signer code path, and
# asserts the same on-chain invariants. Only three things differ, and each is
# explicit rather than special-cased inside the scripts:
#
#   - EXPECTED_CHAIN_ID=31337, so the chain guard has to be told out loud that
#     this is not Sepolia
#   - MATURITY_LEAD_SECS is short, and the wait is a clock warp rather than a
#     wait, because anvil has a warp and a public chain does not
#   - the signer is a keypair generated here, at runtime, funded from anvil
#
# That last point matters: no key material is committed, not even anvil's
# well-known account-0 key. The key exists only in this shell's memory.
#
# Nothing here touches a public network. It spends nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DRY_RUN_PORT:-18546}"
RPC="http://127.0.0.1:$PORT"
ANVIL_PID=""

cleanup() {
  [ -n "$ANVIL_PID" ] && { kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; }
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
DEPLOYER_ADDRESS="$(echo "$WALLET" | jq -r '.[0].address')"
DEPLOYER_PRIVATE_KEY="$(echo "$WALLET" | jq -r '.[0].private_key')"
unset WALLET
cast rpc --rpc-url "$RPC" anvil_setBalance "$DEPLOYER_ADDRESS" 0x21e19e0c9bab2400000 >/dev/null
echo "signer $DEPLOYER_ADDRESS funded (key generated at runtime, never written to disk)"

export SEPOLIA_RPC_URL="$RPC"
export EXPECTED_CHAIN_ID=31337
export DEPLOYER_PRIVATE_KEY
export MATURITY_LEAD_SECS="${MATURITY_LEAD_SECS:-300}"
export ARTIFACT_DIR="${ARTIFACT_DIR:-$HERE/artifacts-dryrun}"
unset DEPLOYER_ACCOUNT || true
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"

say "3 · 01-deploy.sh"
"$HERE/01-deploy.sh"

say "4 · 02-seed-lifecycle.sh"
"$HERE/02-seed-lifecycle.sh"

say "5 · warp past maturity (anvil only; on Sepolia you wait)"
MATURITY="$(jq -r .maturityDate "$ARTIFACT_DIR/lifecycle.json")"
cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp "$((MATURITY + 1))" >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
echo "chain clock now $(cast block latest --rpc-url "$RPC" --field timestamp), maturity was $MATURITY"

say "6 · 03-seed-burn.sh (execs 04-verify-chain.sh)"
"$HERE/03-seed-burn.sh"

say "7 · 05-render-manifest.sh"
CANONICAL_JSON=/nonexistent "$HERE/05-render-manifest.sh"
MANIFEST="$HERE/../src/subgraph/subgraph.sepolia.yaml"
if ! grep -Eq "^ *network: '?sepolia'?" "$MANIFEST"; then
  echo "FATAL: rendered manifest is not on network sepolia" >&2; exit 1
fi
if grep -q "{{" "$MANIFEST"; then
  echo "FATAL: rendered manifest still has unreplaced placeholders" >&2; exit 1
fi
if grep -Eq "^ *startBlock: 0$" "$MANIFEST"; then
  echo "FATAL: startBlock is 0 — that would index from genesis" >&2; exit 1
fi
echo "manifest renders clean: network sepolia, address and startBlock pinned"

say "8 · gas actually used"
total=0
for f in "$HERE"/broadcast/*/31337/run-latest.json; do
  [ -f "$f" ] || continue
  label="$(basename "$(dirname "$(dirname "$f")")")"
  sub=0
  while read -r g; do sub=$((sub + g)); done < <(jq -r '.receipts[].gasUsed' "$f" | while read -r h; do echo $((h)); done)
  printf '  %-28s %10d\n' "$label" "$sub"
  total=$((total + sub))
done
printf '  %-28s %10d\n' "TOTAL" "$total"
echo
echo "At 1.1 gwei that is $(awk -v g="$total" 'BEGIN{printf "%.6f", g*1.1/1e9}') ETH."
echo "At 55 gwei (observed Sepolia spike) it is $(awk -v g="$total" 'BEGIN{printf "%.4f", g*55/1e9}') ETH."

say "DRY RUN PASSED"
echo "The kit deployed, seeded all five entry points, verified 8 leaves and"
echo "5 anchored roots against the fixtures, and rendered a sepolia manifest."
echo
echo "What this does NOT prove: anything about Sepolia, about trace-capable"
echo "indexers, or about the PoC's ZK layer (MockVerifier throughout)."
