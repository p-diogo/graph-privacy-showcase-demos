#!/usr/bin/env bash
# Make this deploy project buildable: fetch EthSystems' PoC at the pin and link
# the libraries it needs into deploy/lib/.
#
# Why a second Foundry project instead of reusing src/contracts/: that project
# is configured for the local harness (its fs_permissions point at build/, its
# scripts read build/deployment.json). Keeping the canonical Sepolia scripts in
# their own root means a Sepolia run can never write over local evidence, and a
# local run can never be mistaken for a canonical one. The libraries are shared
# by symlink, so both projects compile the same PoC bytes at the same pin.
#
# Nothing here touches a network beyond cloning the pinned PoC repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITEM_ROOT="$(cd "$HERE/.." && pwd)"

echo "[prepare] fetching the pinned PoC"
"$ITEM_ROOT/src/poc/fetch-poc.sh"

echo "[prepare] linking libraries into deploy/lib"
mkdir -p "$HERE/lib"
ln -sfn ../../src/contracts/lib/forge-std "$HERE/lib/forge-std"
ln -sfn ../../src/contracts/lib/openzeppelin-contracts "$HERE/lib/openzeppelin-contracts"
ln -sfn ../../src/contracts/lib/private-bond "$HERE/lib/private-bond"
ln -sfn ../../src/contracts/src "$HERE/lib/item01-contracts"

for required in \
  "$HERE/lib/forge-std/src/Script.sol" \
  "$HERE/lib/private-bond/contracts/src/PrivateBond.sol" \
  "$HERE/lib/item01-contracts/MockVerifier.sol"
do
  [ -e "$required" ] || { echo "[prepare] FATAL: missing $required" >&2; exit 1; }
done

mkdir -p "$HERE/artifacts"

echo "[prepare] building"
(cd "$HERE" && forge build >/dev/null)

echo "[prepare] OK — deploy/ is ready"
