#!/usr/bin/env bash
# Make this deploy project buildable and the CLIs runnable.
#
# Nothing here touches a network beyond the package registry and the forge-std
# clone that REPRODUCE.md already documents.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITEM_ROOT="$(cd "$HERE/.." && pwd)"

if [ ! -f "$ITEM_ROOT/src/contracts/lib/forge-std/src/Script.sol" ]; then
  echo "[prepare] fetching forge-std (see REPRODUCE.md §0)"
  git clone --quiet --depth 1 --branch v1.11.0 https://github.com/foundry-rs/forge-std \
    "$ITEM_ROOT/src/contracts/lib/forge-std"
  rm -rf "$ITEM_ROOT/src/contracts/lib/forge-std/.git"
fi

echo "[prepare] linking libraries into deploy/lib"
mkdir -p "$HERE/lib"
ln -sfn ../../src/contracts/lib/forge-std "$HERE/lib/forge-std"
ln -sfn ../../src/contracts/src "$HERE/lib/item02-contracts"

for required in \
  "$HERE/lib/forge-std/src/Script.sol" \
  "$HERE/lib/item02-contracts/AnchorDataEdge.sol"
do
  [ -e "$required" ] || { echo "[prepare] FATAL: missing $required" >&2; exit 1; }
done

mkdir -p "$HERE/artifacts"

echo "[prepare] installing node deps and building the CLIs"
(cd "$ITEM_ROOT" && pnpm install --silent && pnpm build)

echo "[prepare] building contracts"
(cd "$HERE" && forge build >/dev/null)

echo "[prepare] OK — deploy/ is ready"
