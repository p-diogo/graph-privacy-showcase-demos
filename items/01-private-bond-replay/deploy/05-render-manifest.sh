#!/usr/bin/env bash
# Step 5 — render the Sepolia subgraph manifests from the recorded canonical
# deployment.
#
# There is deliberately no second copy of the manifest here. src/subgraph/
# already ships network-agnostic mustache templates ({{network}}, {{address}},
# {{startBlock}}) for both the primary call-handler design and Fallback A; this
# script only supplies sepolia values. A committed "sepolia manifest" would be
# a second source of truth that drifts from the first the moment either is
# edited, and a pinned address that is not the one you deployed is a lie
# waiting to be copied.
#
# Values come from <repo>/deploy/canonical.json when it carries them, and from
# this item's own artifacts/deployment.json otherwise. Read-only; no network.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

CANONICAL="${CANONICAL_JSON:-$REPO_ROOT/deploy/canonical.json}"
SUBGRAPH="$ITEM_ROOT/src/subgraph"
CONFIG="$ARTIFACT_DIR/sepolia-config.json"
NETWORK="${SUBGRAPH_NETWORK:-sepolia}"

address=""
start_block=""

if [ -f "$CANONICAL" ]; then
  address="$(jq -r '.items["01-private-bond-replay"].contracts.privateBond // empty' "$CANONICAL")"
  start_block="$(jq -r '.items["01-private-bond-replay"].deployBlock // empty' "$CANONICAL")"
fi

if [ -n "$address" ] && [ "$address" != "null" ] && [[ "$address" != 0x0000000000000000* ]]; then
  echo "[render] using $CANONICAL"
else
  echo "[render] canonical.json has no recorded address yet; using $ARTIFACT_DIR/deployment.json"
  [ -f "$ARTIFACT_DIR/deployment.json" ] || die "no deployment recorded anywhere — run 01-deploy.sh"
  address="$(jq -r .privateBond "$ARTIFACT_DIR/deployment.json")"
  start_block="$(jq -r .deployBlock "$ARTIFACT_DIR/deployment.json")"
fi

[[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "address $address is not a 20-byte hex address"
[[ "$start_block" =~ ^[0-9]+$ ]] || die "startBlock $start_block is not a number"

jq -n --arg n "$NETWORK" --arg a "$address" --argjson b "$start_block" \
  '{network:$n, address:$a, startBlock:$b}' > "$CONFIG"

cd "$SUBGRAPH"
npx --yes mustache "$CONFIG" subgraph.yaml > subgraph.sepolia.yaml
npx --yes mustache "$CONFIG" subgraph.fallback-a.yaml > subgraph.fallback-a.sepolia.yaml

echo "[render] network      $NETWORK"
echo "[render] address      $address"
echo "[render] startBlock   $start_block"
echo "[render] wrote        src/subgraph/subgraph.sepolia.yaml"
echo "[render] wrote        src/subgraph/subgraph.fallback-a.sepolia.yaml  (only if the trace gate fails)"
