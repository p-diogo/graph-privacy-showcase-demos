#!/usr/bin/env bash
# Step 3 — verify the canonical anchor set straight off the chain, with no
# Graph component anywhere in the trust path.
#
# This is `completeness-checker --source chain`: it rebuilds the anchor set by
# scanning raw Sepolia blocks over the deployment range for transactions to the
# anchor contract carrying the postAnchor selector, and reconciles the
# disclosure against it. If this fails, nothing downstream is worth publishing.
#
# Read-only. Spends nothing, signs nothing.
#
# Scope note the checker prints for itself, repeated here because it is easy to
# over-read a green result: raw-block scanning sees only top-level
# transactions. Completeness is with respect to on-chain emissions, never
# off-chain reality. This is not a proof of reserves.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

require_rpc

DISCLOSURE="$(require_outside_repo ANCHOR_DISCLOSURE "${ANCHOR_DISCLOSURE:-}")"
[ -d "$DISCLOSURE" ] || die "no disclosure bundle at $DISCLOSURE — run 02-seed-anchors.sh first"

TO_BLOCK="${TO_BLOCK:-$(cast block-number --rpc-url "$SEPOLIA_RPC_URL")}"

step "reconcile the disclosure against raw chain data (to block $TO_BLOCK)"
node "$ITEM_ROOT/dist/completeness-checker/cli.js" verify \
  --disclosure "$DISCLOSURE" \
  --source chain \
  --rpc "$SEPOLIA_RPC_URL" \
  --to-block "$TO_BLOCK" \
  ${EVIDENCE_DIR:+--evidence "$EVIDENCE_DIR"}

step "PASS"
echo "The canonical anchor set on chain matches the canonical disclosure."
echo "Next: render the Sepolia manifest (04-render-manifest.sh) and publish."
