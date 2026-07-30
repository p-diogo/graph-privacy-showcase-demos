#!/usr/bin/env bash
# Step 4 — assert the canonical chain state matches the canonical fixtures,
# reading only through public RPC. This is the same check the local seed runs,
# and it is what makes the deployment safe to publish a subgraph over: if the
# chain and the fixtures disagree, every downstream artefact is wrong.
#
# Read-only. Spends nothing, signs nothing.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

require_rpc

BOND="$(jq -r .privateBond "$ARTIFACT_DIR/deployment.json")"
fail=0

step "leaves"
for i in $(seq 0 7); do
  onchain="$(cast call "$BOND" 'commitments(uint256)(bytes32)' "$i" --rpc-url "$SEPOLIA_RPC_URL")"
  expected="$(jq -r ".entries[$i].commitment" "$ARTIFACT_DIR/records-manifest.json")"
  if [ "$onchain" != "$expected" ]; then
    echo "  MISMATCH leaf $i: on-chain $onchain, fixture $expected"
    fail=1
  fi
done
if cast call "$BOND" 'commitments(uint256)(bytes32)' 8 --rpc-url "$SEPOLIA_RPC_URL" >/dev/null 2>&1; then
  echo "  MISMATCH: a ninth leaf exists; the lifecycle should stop at 8"
  fail=1
fi
[ "$fail" -eq 0 ] && echo "  8 leaves match the fixtures"

step "anchored roots"
root_count="$(jq '.expectedRoots | length' "$ARTIFACT_DIR/lifecycle.json")"
for i in $(seq 0 $((root_count - 1))); do
  root="$(jq -r ".expectedRoots[$i]" "$ARTIFACT_DIR/lifecycle.json")"
  known="$(cast call "$BOND" 'knownRoots(bytes32)(bool)' "$root" --rpc-url "$SEPOLIA_RPC_URL")"
  if [ "$known" != "true" ]; then
    echo "  MISMATCH: root $i ($root) is not in knownRoots"
    fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "  $root_count/$root_count rebuilt roots found in knownRoots"

step "bondId"
onchain_bond_id="$(cast call "$BOND" 'bondId()(bytes32)' --rpc-url "$SEPOLIA_RPC_URL")"
expected_bond_id="$(jq -r .bondId "$ARTIFACT_DIR/lifecycle.json")"
if [ "$onchain_bond_id" != "$expected_bond_id" ]; then
  echo "  MISMATCH: bondId $onchain_bond_id != $expected_bond_id"
  fail=1
else
  echo "  $onchain_bond_id"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "VERIFY FAILED: the chain does not match the fixtures. Do not publish a"
  echo "subgraph over this deployment; see RUNBOOK 'Rollback and re-deploy'."
  exit 1
fi

step "PASS"
echo "PrivateBond   $BOND"
echo "deploy block  $(jq -r .deployBlock "$ARTIFACT_DIR/deployment.json")"
echo "verifier      MockVerifier — NOT evidence the PoC's ZK layer works"
echo
echo "Next: render the Sepolia manifest (05-render-manifest.sh) and publish."
