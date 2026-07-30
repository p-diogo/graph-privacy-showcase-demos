#!/usr/bin/env bash
# Step 3 — the fifth entry point: post-maturity burn. Two zero-value leaves,
# two nullifiers. Brings the canonical anchor log to 8 leaves across all five
# anchor-writing functions, so every subgraph decode path sees real traffic.
#
# There is nothing to do but wait for the wall clock. This script tells you how
# much longer rather than failing obscurely.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

require_rpc
signer_args
assert_chain

[ -f "$ARTIFACT_DIR/lifecycle.json" ] || die "no $ARTIFACT_DIR/lifecycle.json — run 01-deploy.sh first"

MATURITY="$(jq -r .maturityDate "$ARTIFACT_DIR/lifecycle.json")"
NOW="$(cast block latest --rpc-url "$SEPOLIA_RPC_URL" --field timestamp)"
if [ "$NOW" -lt "$MATURITY" ]; then
  die "not matured yet: $((MATURITY - NOW))s to go (chain head $NOW, maturity $MATURITY).
Nothing is wrong. Wait and re-run."
fi

step "burn"
(cd "$DEPLOY_DIR" && forge script script/SeedSepoliaBurn.s.sol:SeedSepoliaBurnScript \
  --rpc-url "$SEPOLIA_RPC_URL" "${SIGNER[@]}" --broadcast)

exec "$DEPLOY_DIR/04-verify-chain.sh"
