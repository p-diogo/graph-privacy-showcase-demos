#!/usr/bin/env bash
# Step 2 — the four pre-maturity entry points: mint, mintBatch, transfer,
# atomicSwap. Six leaves, four nullifiers.
#
# Run this promptly after step 1: atomicSwap reverts once the bond has matured,
# so the whole phase has to land inside MATURITY_LEAD_SECS.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

require_rpc
signer_args
assert_chain

[ -f "$ARTIFACT_DIR/lifecycle.json" ] || die "no $ARTIFACT_DIR/lifecycle.json — run 01-deploy.sh first"

MATURITY="$(jq -r .maturityDate "$ARTIFACT_DIR/lifecycle.json")"
NOW="$(cast block latest --rpc-url "$SEPOLIA_RPC_URL" --field timestamp)"
if [ "$NOW" -ge "$MATURITY" ]; then
  die "the chain clock ($NOW) is already past maturity ($MATURITY).
atomicSwap will revert with 'Bond A already matured'. Re-run 01-deploy.sh with a
longer MATURITY_LEAD_SECS — the old deployment is dead weight, not recoverable."
fi
echo "$((MATURITY - NOW))s of headroom before maturity"

step "seed mint / mintBatch / transfer / atomicSwap"
(cd "$DEPLOY_DIR" && forge script script/SeedSepoliaLifecycle.s.sol:SeedSepoliaLifecycleScript \
  --rpc-url "$SEPOLIA_RPC_URL" "${SIGNER[@]}" --broadcast)

BOND="$(jq -r .privateBond "$ARTIFACT_DIR/deployment.json")"
LEAVES=0
while cast call "$BOND" 'commitments(uint256)(bytes32)' "$LEAVES" --rpc-url "$SEPOLIA_RPC_URL" >/dev/null 2>&1; do
  LEAVES=$((LEAVES + 1))
done

step "done"
echo "leaves on chain: $LEAVES (expected 6)"
[ "$LEAVES" -eq 6 ] || die "expected 6 leaves after phase 1, found $LEAVES"
echo
echo "Wait until unix $MATURITY, then run 03-seed-burn.sh."
echo "  local time: $(date -r "$MATURITY" 2>/dev/null || date -d "@$MATURITY" 2>/dev/null || echo "unix $MATURITY")"
