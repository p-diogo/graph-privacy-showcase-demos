#!/usr/bin/env bash
# Shared environment loading and signer selection for the canonical deploy
# scripts. Sourced, never executed.
#
# Secret handling rules this file enforces:
#   - no key is ever echoed, and no script here runs `set -x`
#   - the preferred signer is an encrypted Foundry keystore, so the key is
#     never in argv or the environment at all
#   - a raw key is supported for convenience, with an honest warning, because
#     argv is readable by other users on the same machine via `ps`
#   - .env is gitignored and no script writes to it

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITEM_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ITEM_ROOT/../.." && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$DEPLOY_DIR/artifacts}"

if [ -f "$DEPLOY_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DEPLOY_DIR/.env"
  set +a
fi

: "${EXPECTED_CHAIN_ID:=11155111}"
export EXPECTED_CHAIN_ID ARTIFACT_DIR

die() { echo "FATAL: $*" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$1"; }

require_rpc() {
  [ -n "${SEPOLIA_RPC_URL:-}" ] || die "SEPOLIA_RPC_URL is not set (copy .env.example to .env)"
}

# Populates the SIGNER array with forge wallet flags. Never prints key material.
signer_args() {
  SIGNER=()
  if [ -n "${DEPLOYER_ACCOUNT:-}" ]; then
    SIGNER=(--account "$DEPLOYER_ACCOUNT")
    [ -n "${DEPLOYER_ADDRESS:-}" ] && SIGNER+=(--sender "$DEPLOYER_ADDRESS")
  elif [ -n "${DEPLOYER_PRIVATE_KEY:-}" ]; then
    echo "note: signing with a raw key from the environment." >&2
    echo "      argv is readable by other users on this machine (ps)." >&2
    echo "      'cast wallet import canonical-deployer --interactive' + DEPLOYER_ACCOUNT avoids that." >&2
    SIGNER=(--private-key "$DEPLOYER_PRIVATE_KEY")
  else
    die "no signer: set DEPLOYER_ACCOUNT (preferred) or DEPLOYER_PRIVATE_KEY"
  fi
}

# Confirm the RPC really is the chain we expect before spending anything.
assert_chain() {
  local actual
  actual="$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")"
  [ "$actual" = "$EXPECTED_CHAIN_ID" ] ||
    die "RPC reports chain id $actual, expected $EXPECTED_CHAIN_ID"
  echo "chain id $actual confirmed"
}
