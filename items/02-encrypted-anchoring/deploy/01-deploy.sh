#!/usr/bin/env bash
# Step 1 — deploy the canonical AnchorDataEdge and record its real deploy block.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

require_rpc
signer_args
assert_chain

mkdir -p "$ARTIFACT_DIR"

step "1 · deploy AnchorDataEdge"
(cd "$DEPLOY_DIR" && forge script script/DeploySepolia.s.sol:DeploySepoliaScript \
  --rpc-url "$SEPOLIA_RPC_URL" "${SIGNER[@]}" --broadcast)

step "2 · record the real deploy block from the chain"
RUN="$DEPLOY_DIR/broadcast/DeploySepolia.s.sol/$EXPECTED_CHAIN_ID/run-latest.json"
[ -f "$RUN" ] || die "no broadcast record at $RUN — did the deploy actually send?"
DEPLOY_TX="$(jq -r '.transactions[] | select(.contractName == "AnchorDataEdge") | .hash' "$RUN")"
[ -n "$DEPLOY_TX" ] || die "no AnchorDataEdge creation transaction in $RUN"
BLOCK="$(cast receipt "$DEPLOY_TX" blockNumber --rpc-url "$SEPOLIA_RPC_URL")"
BLOCK="$((BLOCK))"
[ "$BLOCK" -gt 0 ] || die "receipt reports block $BLOCK; refusing to record a startBlock of 0"

tmp="$(mktemp)"
jq --argjson b "$BLOCK" --arg t "$DEPLOY_TX" \
  '.deployBlock = $b | .deployTx = $t' "$ARTIFACT_DIR/deployment.json" > "$tmp"
mv "$tmp" "$ARTIFACT_DIR/deployment.json"

ADDR="$(jq -r .anchorDataEdge "$ARTIFACT_DIR/deployment.json")"

step "3 · confirm the deployed code is the no-op we expect"
CODE="$(cast code "$ADDR" --rpc-url "$SEPOLIA_RPC_URL")"
[ "$CODE" != "0x" ] || die "no code at $ADDR"
echo "runtime bytecode: $(( (${#CODE} - 2) / 2 )) bytes"

step "done"
echo "AnchorDataEdge  $ADDR"
echo "deploy tx       $DEPLOY_TX"
echo "deploy block    $BLOCK   <- the subgraph startBlock"
echo
echo "Record these in deploy/canonical.json, then run 02-seed-anchors.sh."
