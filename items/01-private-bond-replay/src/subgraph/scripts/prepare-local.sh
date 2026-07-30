#!/usr/bin/env bash
# Render the templated manifests into runnable ones.
#
# `subgraph.yaml` carries {{network}}/{{address}}/{{startBlock}} placeholders,
# so nothing — not codegen, not the mapping unit tests — works until they are
# filled in. The values come from a live deployment when one exists, and from a
# committed default otherwise, so a clean checkout can run codegen and tests
# without first seeding a chain.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBGRAPH="$(cd "$HERE/.." && pwd)"
GENERATED_CONFIG="$SUBGRAPH/../../build/subgraph-config.json"
DEFAULT_CONFIG="$SUBGRAPH/config/local-default.json"

if [ -f "$GENERATED_CONFIG" ]; then
  CONFIG="$GENERATED_CONFIG"
  echo "[prepare-local] using the deployed config: $CONFIG"
else
  CONFIG="$DEFAULT_CONFIG"
  echo "[prepare-local] no deployment yet; using committed defaults: $CONFIG"
  echo "[prepare-local] enough for codegen and unit tests; seed a chain before deploying"
fi

cd "$SUBGRAPH"
npx mustache "$CONFIG" subgraph.yaml > subgraph.local.yaml
npx mustache "$CONFIG" subgraph.fallback-a.yaml > subgraph.fallback-a.local.yaml

echo "[prepare-local] wrote subgraph.local.yaml and subgraph.fallback-a.local.yaml"
