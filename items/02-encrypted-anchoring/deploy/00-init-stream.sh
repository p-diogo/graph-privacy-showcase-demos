#!/usr/bin/env bash
# Step 0 — generate the canonical stream's keyfile, once, outside the repo.
#
# Run this exactly once for the canonical deployment. Re-running with --force
# would mint a new streamId, which orphans every anchor already posted: the
# subgraph would index the old stream and the checker would look for the new
# one. This script refuses to overwrite.
#
# The keyfile is demo-grade by design (cleartext, local file, no KMS) and this
# item claims nothing about key management. What it must not be is *in the
# repository*.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

KEYSTORE="$(require_outside_repo ANCHOR_KEYSTORE "${ANCHOR_KEYSTORE:-}")"

if [ -f "$KEYSTORE" ]; then
  echo "keyfile already exists at $KEYSTORE"
  echo "streamId $(jq -r .streamId "$KEYSTORE")"
  echo
  echo "Not regenerating. A new streamId would orphan every anchor already posted."
  exit 0
fi

step "generate the canonical stream keyfile"
node "$ITEM_ROOT/dist/anchor-writer/cli.js" init --keystore "$KEYSTORE"
chmod 600 "$KEYSTORE"

echo
echo "keyfile   $KEYSTORE  (mode 600, outside the repository)"
echo "streamId  $(jq -r .streamId "$KEYSTORE")"
echo
echo "Back this up before posting anchors. Without it the canonical stream"
echo "cannot be disclosed, and an undisclosable stream is an unverifiable demo."
