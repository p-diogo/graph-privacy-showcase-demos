#!/usr/bin/env bash
# Deploy EthSystems' PrivateBond to a local anvil chain and run the full
# five-entry-point lifecycle of spec §4.2.
#
# Determinism is the point of this script. Anvil is started at a fixed genesis
# timestamp and with its default deterministic accounts, and every commitment
# comes from `bond-replay seed-fixtures`, which is a pure function of its
# constants. Re-running from a fresh chain must produce a byte-identical anchor
# log; tests/integration/determinism.sh asserts exactly that.
#
# LOCAL ONLY. This script never targets a public network and holds no funds.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITEM_ROOT="$(cd "$HERE/../.." && pwd)"
BUILD_DIR="$ITEM_ROOT/build"
CONTRACTS="$ITEM_ROOT/src/contracts"
REPLAY="$ITEM_ROOT/src/replay"

# Fixed chain genesis, matching fixtures::FIXTURE_GENESIS_TS.
GENESIS_TS=1893456000
MATURITY_TS=1893459600
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
ANVIL_PORT="${ANVIL_PORT:-8545}"

# Anvil's default deterministic account 0, referenced by address only.
#
# No private key appears in this repo, deliberately — not even a valueless
# well-known one. anvil unlocks its dev accounts, so `--unlocked --sender`
# signs through the node and nothing here has to hold key material. The
# Sepolia leg would supply a key through the environment, never a file.
DEPLOYER_ADDRESS="${DEPLOYER_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"

ANVIL_PID=""
KEEP_ANVIL="${KEEP_ANVIL:-0}"

cleanup() {
  if [ -n "$ANVIL_PID" ] && [ "$KEEP_ANVIL" != "1" ]; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step() { printf '\n=== %s ===\n' "$1"; }

step "0 · fetch the pinned PoC"
"$ITEM_ROOT/src/poc/fetch-poc.sh"

step "1 · generate deterministic fixtures"
mkdir -p "$BUILD_DIR"
(cd "$REPLAY" && cargo run --quiet --release --bin bond-replay -- seed-fixtures --out-dir "$BUILD_DIR")

step "2 · start anvil at a fixed genesis timestamp"
if [ "${REUSE_ANVIL:-0}" = "1" ]; then
  cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 || {
    echo "REUSE_ANVIL=1 but nothing is listening on $RPC_URL" >&2
    exit 1
  }
  echo "reusing the chain already listening on $RPC_URL"
else
  # Refuse to run against a chain we did not start.
  #
  # anvil cannot bind an occupied port, so it would exit while the readiness
  # probe below happily succeeded against the *existing* node. The seed would
  # then deploy onto someone else's chain — and if that chain is a previous
  # run's, its clock is already past maturity and `atomicSwap` reverts with
  # "Bond A already matured", which says nothing about the real cause.
  if cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; then
    echo "FATAL: something is already listening on $RPC_URL." >&2
    echo "This script needs a chain it starts itself at genesis $GENESIS_TS." >&2
    echo "Stop it first:  pkill -f 'anvil --port $ANVIL_PORT'" >&2
    echo "Or set REUSE_ANVIL=1 if you know the chain is freshly seeded." >&2
    exit 1
  fi

  anvil --port "$ANVIL_PORT" --timestamp "$GENESIS_TS" --silent &
  ANVIL_PID=$!
  for _ in $(seq 1 50); do
    if cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  cast block-number --rpc-url "$RPC_URL" >/dev/null

  # Prove it is the chain we asked for, not a survivor that won the port race.
  ACTUAL_GENESIS="$(cast block 0 --rpc-url "$RPC_URL" --field timestamp)"
  if [ "$ACTUAL_GENESIS" != "$GENESIS_TS" ]; then
    echo "FATAL: block 0 timestamp is $ACTUAL_GENESIS, expected $GENESIS_TS." >&2
    echo "The chain on $RPC_URL is not the one this script started." >&2
    exit 1
  fi
  echo "anvil up (pid $ANVIL_PID) at genesis $GENESIS_TS"
fi

step "3 · deploy PrivateBond (unmodified) behind MockVerifier"
(cd "$CONTRACTS" && forge script script/DeployLocal.s.sol:DeployLocalScript \
  --rpc-url "$RPC_URL" --unlocked --sender "$DEPLOYER_ADDRESS" --broadcast --skip-simulation)

BOND_ADDR="$(jq -r .privateBond "$BUILD_DIR/deployment.json")"
echo "PrivateBond at $BOND_ADDR"

step "4 · run mint / mintBatch / transfer / atomicSwap"
(cd "$CONTRACTS" && forge script script/SeedLifecycle.s.sol:SeedLifecycleScript \
  --rpc-url "$RPC_URL" --unlocked --sender "$DEPLOYER_ADDRESS" --broadcast --skip-simulation)

step "5 · advance the chain clock past maturity"
cast rpc --rpc-url "$RPC_URL" evm_setNextBlockTimestamp "$((MATURITY_TS + 1))" >/dev/null
cast rpc --rpc-url "$RPC_URL" evm_mine >/dev/null
echo "chain clock now $(cast block latest --rpc-url "$RPC_URL" --field timestamp)"

step "6 · run burn"
(cd "$CONTRACTS" && forge script script/SeedBurn.s.sol:SeedBurnScript \
  --rpc-url "$RPC_URL" --unlocked --sender "$DEPLOYER_ADDRESS" --broadcast --skip-simulation)

step "7 · assert the on-chain anchor log matches the fixtures"
fail=0

for i in $(seq 0 7); do
  onchain="$(cast call "$BOND_ADDR" 'commitments(uint256)(bytes32)' "$i" --rpc-url "$RPC_URL")"
  expected="$(jq -r ".entries[$i].commitment" "$BUILD_DIR/records-manifest.json")"
  if [ "$onchain" != "$expected" ]; then
    echo "MISMATCH leaf $i: on-chain $onchain, fixture $expected"
    fail=1
  fi
done

if cast call "$BOND_ADDR" 'commitments(uint256)(bytes32)' 8 --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "MISMATCH: a ninth leaf exists; the lifecycle should stop at 8"
  fail=1
fi

root_count="$(jq '.expectedRoots | length' "$BUILD_DIR/lifecycle.json")"
for i in $(seq 0 $((root_count - 1))); do
  root="$(jq -r ".expectedRoots[$i]" "$BUILD_DIR/lifecycle.json")"
  known="$(cast call "$BOND_ADDR" 'knownRoots(bytes32)(bool)' "$root" --rpc-url "$RPC_URL")"
  if [ "$known" != "true" ]; then
    echo "MISMATCH: root $i ($root) is not in knownRoots"
    fail=1
  fi
done

onchain_bond_id="$(cast call "$BOND_ADDR" 'bondId()(bytes32)' --rpc-url "$RPC_URL")"
expected_bond_id="$(jq -r .bondId "$BUILD_DIR/lifecycle.json")"
if [ "$onchain_bond_id" != "$expected_bond_id" ]; then
  echo "MISMATCH: bondId $onchain_bond_id != $expected_bond_id"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "SEED FAILED: the chain does not match the fixtures."
  exit 1
fi

echo "8 leaves, $root_count anchored roots, bondId — all match the fixtures."
echo
echo "Deployment:   $BOND_ADDR"
echo "Verifier:     MockVerifier (spec §4.2 default; NOT evidence the PoC's ZK layer works)"
echo "Fixtures:     $BUILD_DIR/records-manifest.json"
