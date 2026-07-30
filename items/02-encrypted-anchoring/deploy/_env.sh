#!/usr/bin/env bash
# Shared environment loading, signer selection and key-location enforcement for
# the canonical deploy scripts. Sourced, never executed.
#
# Two secrets are in play here and they are different things:
#
#   DEPLOYER_*        the Ethereum key that pays for and signs anchor
#                     transactions. Value: Sepolia ETH. Rotate after use.
#
#   ANCHOR_KEYSTORE   the canonical stream's keyfile (streamId + streamKey).
#                     This is NOT an Ethereum key and holds no funds, but
#                     whoever has it can compute valid envelopes for the
#                     canonical stream and — because AnchorDataEdge is
#                     permissionless — post conflicting anchors at existing
#                     seqs from any funded account. The checker flags those as
#                     CONFLICT, so the damage is detectable rather than silent,
#                     but a polluted canonical stream is still a worse demo.
#
# The stream keyfile therefore lives OUTSIDE this repository and these scripts
# refuse to run if it does not. It stops being a secret the moment the
# disclosure bundle is published, which is deliberate and is what makes Mode A
# reproducible — see RUNBOOK, "the canonical stream key".

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

assert_chain() {
  local actual
  actual="$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")"
  [ "$actual" = "$EXPECTED_CHAIN_ID" ] ||
    die "RPC reports chain id $actual, expected $EXPECTED_CHAIN_ID"
  echo "chain id $actual confirmed"
}

# Resolve a path without requiring it to exist yet.
abspath() {
  local dir base
  dir="$(dirname "$1")"
  base="$(basename "$1")"
  [ -d "$dir" ] || die "directory $dir does not exist (create it first)"
  echo "$(cd "$dir" && pwd)/$base"
}

# The canonical stream keyfile must not live inside the repository. A key in a
# working tree is a key that gets committed by an unrelated `git add -A`.
require_outside_repo() {
  local label="$1" path="$2" resolved
  [ -n "$path" ] || die "$label is not set"
  resolved="$(abspath "$path")" || die "$label could not be resolved"
  # abspath's own die runs in a nested subshell and cannot stop this script;
  # an empty result means it failed (e.g. parent directory missing).
  [ -n "$resolved" ] || die "$label could not be resolved (does its parent directory exist?)"
  case "$resolved" in
    "$REPO_ROOT"/*)
      die "$label points inside the repository ($resolved).
The canonical stream keyfile must live outside the working tree — a key in a
repo is a key that gets committed by an unrelated 'git add -A'.
Suggested home: \$HOME/.graph-privacy-showcase/canonical/"
      ;;
  esac
  echo "$resolved"
}
