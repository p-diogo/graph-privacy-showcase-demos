#!/usr/bin/env bash
# Fetch EthSystems' private-bond PoC at the pinned SHA and wire it into our
# Foundry project as read-only libraries.
#
# The PoC is never modified. Our contracts (MockVerifier, the stand-in, the
# seed scripts) live in src/contracts/ and only ever *call* theirs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITEM_ROOT="$(cd "$HERE/../.." && pwd)"
BUILD_DIR="$ITEM_ROOT/build"
POC_DIR="$BUILD_DIR/poc"
CUSTOM_UTXO="$POC_DIR/pocs/private-bond/custom-utxo"

# shellcheck disable=SC1091
source "$HERE/PIN"

mkdir -p "$BUILD_DIR"

if [ -d "$POC_DIR/.git" ]; then
  echo "[fetch-poc] existing clone at $POC_DIR"
else
  echo "[fetch-poc] cloning $POC_REPO"
  git clone --quiet "$POC_REPO" "$POC_DIR"
fi

echo "[fetch-poc] checking out $POC_SHA"
git -C "$POC_DIR" fetch --quiet origin "$POC_SHA"
git -C "$POC_DIR" checkout --quiet "$POC_SHA"

ACTUAL_SHA="$(git -C "$POC_DIR" rev-parse HEAD)"
if [ "$ACTUAL_SHA" != "$POC_SHA" ]; then
  echo "[fetch-poc] FATAL: HEAD is $ACTUAL_SHA, expected $POC_SHA" >&2
  exit 1
fi

echo "[fetch-poc] initializing pinned submodules"
git -C "$POC_DIR" submodule update --quiet --init --depth 1 \
  "$SUBMODULE_FORGE_STD_PATH" "$SUBMODULE_OPENZEPPELIN_PATH"

# Fail loudly if the upstream layout moved rather than silently producing an
# unbuildable tree.
for required in \
  "$CUSTOM_UTXO/contracts/src/PrivateBond.sol" \
  "$CUSTOM_UTXO/contracts/src/PoseidonT3.sol" \
  "$CUSTOM_UTXO/contracts/src/Verifier.sol" \
  "$CUSTOM_UTXO/contracts/lib/forge-std/src/Script.sol" \
  "$CUSTOM_UTXO/contracts/lib/openzeppelin-contracts/contracts/access/Ownable.sol"
do
  [ -f "$required" ] || { echo "[fetch-poc] FATAL: missing $required" >&2; exit 1; }
done

echo "[fetch-poc] linking libraries into src/contracts/lib"
LIB="$ITEM_ROOT/src/contracts/lib"
mkdir -p "$LIB"
ln -sfn "$CUSTOM_UTXO/contracts/lib/forge-std" "$LIB/forge-std"
ln -sfn "$CUSTOM_UTXO/contracts/lib/openzeppelin-contracts" "$LIB/openzeppelin-contracts"
ln -sfn "$CUSTOM_UTXO" "$LIB/private-bond"

echo "[fetch-poc] OK — ethsystems/pocs @ $ACTUAL_SHA"
