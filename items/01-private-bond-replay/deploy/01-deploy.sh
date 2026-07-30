#!/usr/bin/env bash
# Step 1 — generate the canonical fixtures at a real wall-clock maturity, then
# deploy MockVerifier + EthSystems' unmodified PrivateBond.
#
# Fixtures and deployment are one step on purpose. Maturity is an input to
# every note commitment, so a fixture set and a deployment only make sense as a
# pair; generating them separately invites a silent mismatch that would not
# surface until reconciliation.
#
# MATURITY_LEAD_SECS is how long you will wait between step 2 and step 3.
# Default 3600 (spec §4.2's "deploy + 1 hour"). Shorten it for a rehearsal;
# do not shorten it below the time you need to get step 2 confirmed.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

require_rpc
signer_args
assert_chain

MATURITY_LEAD_SECS="${MATURITY_LEAD_SECS:-3600}"

step "1 · generate fixtures at a wall-clock maturity"
NOW="$(cast block latest --rpc-url "$SEPOLIA_RPC_URL" --field timestamp)"
MATURITY=$((NOW + MATURITY_LEAD_SECS))
echo "chain head timestamp $NOW"
echo "maturity             $MATURITY  (+${MATURITY_LEAD_SECS}s)"

mkdir -p "$ARTIFACT_DIR"
(cd "$ITEM_ROOT/src/replay" &&
  cargo run --quiet --release --bin bond-replay -- \
    seed-fixtures --out-dir "$ARTIFACT_DIR" --maturity "$MATURITY")

step "2 · deploy MockVerifier + PrivateBond"
echo "Verifier: MockVerifier (spec §4.2 default)."
echo "This is NOT evidence that the PoC's ZK layer works — see DeploySepolia.s.sol."
(cd "$DEPLOY_DIR" && forge script script/DeploySepolia.s.sol:DeploySepoliaScript \
  --rpc-url "$SEPOLIA_RPC_URL" "${SIGNER[@]}" --broadcast)

step "3 · record the real deploy block from the chain"
# `block.number` inside a forge script is the simulation block, not the block
# the transaction landed in — on a fresh chain it reads 0. A subgraph
# startBlock of 0 would index from genesis, which on Sepolia means millions of
# empty blocks. Take the number from the receipt instead.
RUN="$DEPLOY_DIR/broadcast/DeploySepolia.s.sol/$EXPECTED_CHAIN_ID/run-latest.json"
[ -f "$RUN" ] || die "no broadcast record at $RUN — did the deploy actually send?"
DEPLOY_TX="$(jq -r '.transactions[] | select(.contractName == "PrivateBond") | .hash' "$RUN")"
[ -n "$DEPLOY_TX" ] || die "no PrivateBond creation transaction in $RUN"
BLOCK="$(cast receipt "$DEPLOY_TX" blockNumber --rpc-url "$SEPOLIA_RPC_URL")"
BLOCK="$((BLOCK))"
[ "$BLOCK" -gt 0 ] || die "receipt reports block $BLOCK; refusing to record a startBlock of 0"

tmp="$(mktemp)"
jq --argjson b "$BLOCK" --arg t "$DEPLOY_TX" \
  '.deployBlock = $b | .deployTx = $t' "$ARTIFACT_DIR/deployment.json" > "$tmp"
mv "$tmp" "$ARTIFACT_DIR/deployment.json"

BOND="$(jq -r .privateBond "$ARTIFACT_DIR/deployment.json")"

step "done"
echo "PrivateBond   $BOND"
echo "deploy tx     $DEPLOY_TX"
echo "deploy block  $BLOCK   <- the subgraph startBlock"
echo "maturity      $MATURITY"
echo
echo "Record these in deploy/canonical.json, then run 02-seed-lifecycle.sh."
