#!/usr/bin/env bash
# Step 2 — post the canonical anchor stream, then build the disclosure bundle.
#
# Ten records from fixtures/records.jsonl, encrypted deterministically
# (AES-256-GCM-SIV with HKDF-derived key and nonce, AAD-bound to position), one
# `postAnchor` transaction per record in seq order, each awaited to a receipt.
# Sequential submission from a single EOA is what makes seq order and block
# order agree, which is what makes the served index order-deterministic.
#
# By default it also posts two awkward cases, because a real anchor contract is
# callable by anyone and the canonical index should be seen handling them:
# a 5-byte junk payload (-> MalformedAnchor) and an identical re-submission of
# seq 0 (-> duplicateCount). Neither breaks the disclosure; the checker reports
# both as notes and still exits 0. Set SEED_EDGE_CASES=0 to skip them.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

require_rpc
assert_chain

KEYSTORE="$(require_outside_repo ANCHOR_KEYSTORE "${ANCHOR_KEYSTORE:-}")"
ARCHIVE="$(require_outside_repo ANCHOR_ARCHIVE "${ANCHOR_ARCHIVE:-}")"
DISCLOSURE="$(require_outside_repo ANCHOR_DISCLOSURE "${ANCHOR_DISCLOSURE:-}")"
[ -f "$KEYSTORE" ] || die "no keyfile at $KEYSTORE — run 00-init-stream.sh first"

# The writer needs a raw key: it is a viem CLI and cannot read a Foundry
# keystore. If you sign with --account, decrypt it yourself into the
# environment for this one step and unset it afterwards:
#   read -rs ANCHOR_WRITER_PRIVATE_KEY && export ANCHOR_WRITER_PRIVATE_KEY
if [ -z "${ANCHOR_WRITER_PRIVATE_KEY:-}" ]; then
  if [ -n "${DEPLOYER_PRIVATE_KEY:-}" ]; then
    export ANCHOR_WRITER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY"
  else
    die "the anchor-writer needs ANCHOR_WRITER_PRIVATE_KEY (it cannot read a Foundry keystore).
Set it for this step only, or use DEPLOYER_PRIVATE_KEY for the whole run."
  fi
fi

[ -f "$ARTIFACT_DIR/deployment.json" ] || die "no $ARTIFACT_DIR/deployment.json — run 01-deploy.sh first"
CONTRACT="$(jq -r .anchorDataEdge "$ARTIFACT_DIR/deployment.json")"
RECORDS="${ANCHOR_RECORDS:-$ITEM_ROOT/fixtures/records.jsonl}"

if [ -f "$ARCHIVE" ]; then
  die "an archive already exists at $ARCHIVE.
Posting again would put a second copy of every anchor on chain — the index
would report them as duplicates, which is honest but is not the clean canonical
stream you want. Move the old archive aside deliberately if you mean to re-post."
fi

step "1 · post $(wc -l < "$RECORDS" | tr -d ' ') anchors to $CONTRACT"
node "$ITEM_ROOT/dist/anchor-writer/cli.js" post \
  --records "$RECORDS" \
  --keystore "$KEYSTORE" \
  --contract "$CONTRACT" \
  --rpc "$SEPOLIA_RPC_URL" \
  --archive "$ARCHIVE"

if [ "${SEED_EDGE_CASES:-1}" = "1" ]; then
  step "2 · post the two awkward cases"
  echo "a 5-byte junk payload -> MalformedAnchor"
  cast send --rpc-url "$SEPOLIA_RPC_URL" --private-key "$ANCHOR_WRITER_PRIVATE_KEY" \
    "$CONTRACT" "postAnchor(bytes)" 0x0102030405 >/dev/null
  echo "an identical re-submission of seq 0 -> duplicateCount"
  cast send --rpc-url "$SEPOLIA_RPC_URL" --private-key "$ANCHOR_WRITER_PRIVATE_KEY" \
    "$CONTRACT" "postAnchor(bytes)" "$(jq -r '.anchors[0].envelope' "$ARCHIVE")" >/dev/null
fi

step "3 · build the auditor's disclosure bundle"
node "$ITEM_ROOT/dist/anchor-writer/cli.js" disclose \
  --archive "$ARCHIVE" \
  --records "$RECORDS" \
  --keystore "$KEYSTORE" \
  --out "$DISCLOSURE"

END_BLOCK="$(jq -r .endBlock "$ARCHIVE")"
STREAM_ID="$(jq -r .streamId "$ARCHIVE")"

step "done"
echo "contract      $CONTRACT"
echo "streamId      $STREAM_ID"
echo "anchors       $(jq '.anchors | length' "$ARCHIVE")"
echo "blocks        $(jq -r .startBlock "$ARCHIVE") .. $END_BLOCK"
echo "archive       $ARCHIVE       (owner's off-chain store; keep)"
echo "disclosure    $DISCLOSURE    (contains the stream key; publishing it is a decision)"
echo
echo "Record streamId, block range and the disclosure location in deploy/canonical.json."
