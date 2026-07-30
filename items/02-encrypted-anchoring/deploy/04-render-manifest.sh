#!/usr/bin/env bash
# Step 4 — render the Sepolia subgraph manifest from the recorded canonical
# deployment.
#
# There is deliberately no second manifest template here. src/subgraph/ already
# ships a network-agnostic one ({{network}}, {{address}}, {{startBlock}},
# {{mappingFile}}) rendered by src/tools/gen-manifest.ts; this script only
# supplies sepolia values and a distinct output filename, so a canonical
# manifest can never be confused with a locally-rendered one. A committed
# "sepolia manifest" would be a second source of truth that drifts the moment
# either is edited.
#
# Values come from <repo>/deploy/canonical.json when it carries them, and from
# this item's own artifacts/deployment.json otherwise. Read-only; no network.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

CANONICAL="${CANONICAL_JSON:-$REPO_ROOT/deploy/canonical.json}"
NETWORK="${SUBGRAPH_NETWORK:-sepolia}"
OUT="${MANIFEST_OUT:-src/subgraph/subgraph.sepolia.yaml}"

address=""
start_block=""

if [ -f "$CANONICAL" ]; then
  address="$(jq -r '.items["02-encrypted-anchoring"].contracts.anchorDataEdge // empty' "$CANONICAL")"
  start_block="$(jq -r '.items["02-encrypted-anchoring"].deployBlock // empty' "$CANONICAL")"
fi

if [ -n "$address" ] && [ "$address" != "null" ] && [[ "$address" != 0x0000000000000000* ]]; then
  echo "[render] using $CANONICAL"
else
  echo "[render] canonical.json has no recorded address yet; using $ARTIFACT_DIR/deployment.json"
  [ -f "$ARTIFACT_DIR/deployment.json" ] || die "no deployment recorded anywhere — run 01-deploy.sh"
  address="$(jq -r .anchorDataEdge "$ARTIFACT_DIR/deployment.json")"
  start_block="$(jq -r .deployBlock "$ARTIFACT_DIR/deployment.json")"
fi

[[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "address $address is not a 20-byte hex address"
[[ "$start_block" =~ ^[0-9]+$ ]] || die "startBlock $start_block is not a number"

cd "$ITEM_ROOT"
node dist/tools/gen-manifest.js \
  --network "$NETWORK" \
  --address "$address" \
  --start-block "$start_block" \
  --out "$OUT"

echo "[render] network      $NETWORK"
echo "[render] address      $address"
echo "[render] startBlock   $start_block"
echo "[render] wrote        $OUT"
echo
echo "The bad-server variants are local-only test fixtures and are never"
echo "rendered for a public network."
