#!/usr/bin/env bash
# Item 02 — local integration suite.
#
# Runs the whole item end to end against a local chain and a local graph-node:
# deploy, anchor, index with a call-handler subgraph, reconcile, and then break
# things on purpose and require the checker to notice. Nothing here touches a
# public network, spends anything, or queries a production gateway.
#
# What it proves:
#   1. a call-handler subgraph indexes calldata-only anchors (locally)
#   2. the served index agrees entity-for-entity with a raw block scan
#   3. every verdict the checker advertises fires on a real broken input
#   4. a from-scratch re-index reproduces the same entities and the same POI
#
# Usage: tests/integration/run.sh   (from the item root)
set -euo pipefail

ITEM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ITEM_ROOT"

WORK="${ITEM_ROOT}/.local"
LOGS="${WORK}/logs"
COMPOSE="src/local-stack/docker-compose.yml"
RPC_URL="http://127.0.0.1:18545"
GRAPH_ADMIN="http://localhost:18020/"
GRAPH_QUERY="http://localhost:18000/subgraphs/name"
GRAPH_STATUS="http://localhost:18030/graphql"
IPFS_URL="http://localhost:15001"
# anvil's first deterministic account. Public, worthless, and local-only.
WRITER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
NETWORK_NAME="anvil-local"

PASSES=0
FAILURES=0

log()  { printf '\n=== %s\n' "$*"; }
ok()   { PASSES=$((PASSES + 1)); printf 'CHECK-PASS  %s\n' "$*"; }
bad()  { FAILURES=$((FAILURES + 1)); printf 'CHECK-FAIL  %s\n' "$*"; }

cleanup() {
  local status=$?
  log "cleanup"
  docker compose -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "${ANVIL_PID:-}" ]]; then kill "$ANVIL_PID" >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT

expect_exit() {
  local expected="$1" description="$2"
  shift 2
  set +e
  "$@" >"${LOGS}/last-command.log" 2>&1
  local actual=$?
  set -e
  if [[ "$actual" == "$expected" ]]; then
    ok "${description} (exit ${actual})"
  else
    bad "${description}: expected exit ${expected}, got ${actual}"
    sed 's/^/      /' "${LOGS}/last-command.log"
  fi
  cat "${LOGS}/last-command.log"
}

expect_output() {
  local needle="$1" file="$2" description="$3"
  if grep -qF -- "$needle" "$file"; then
    ok "$description"
  else
    bad "${description}: '${needle}' not found in ${file}"
  fi
}

rm -rf "$WORK"
mkdir -p "$LOGS"

log "0 · preflight"
for tool in docker forge cast anvil node pnpm jq curl; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool"; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon is not running"; exit 1; }
pnpm run build >/dev/null
echo "toolchain ok"

# The stack uses a private port range so it can share a machine with another
# graph-node stack. If any of those ports is taken, stop: silently talking to
# someone else's node would produce evidence about the wrong system.
for port in 18545 18000 18020 18030 15001 15432; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port ${port} is already in use; refusing to run against a node this suite did not start"
    exit 1
  fi
done

log "1 · local chain"
anvil --host 0.0.0.0 --port 18545 --silent >"${LOGS}/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 40); do
  cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
  sleep 0.25
done
GENESIS_HEIGHT=$(cast block-number --rpc-url "$RPC_URL")
if [[ "$GENESIS_HEIGHT" == "0" ]]; then
  ok "started a fresh local chain (height 0)"
else
  bad "local chain is not fresh (height ${GENESIS_HEIGHT}); results would not be reproducible"
  exit 1
fi
# Prove the capability the whole design depends on, on this exact node.
if cast rpc --rpc-url "$RPC_URL" trace_filter '{"fromBlock":"0x0","toBlock":"0x1"}' >/dev/null 2>&1; then
  ok "local node answers trace_filter (call handlers can be served here)"
else
  bad "local node does not answer trace_filter — a call-handler subgraph cannot sync against it"
  exit 1
fi

log "2 · deploy the anchor contract"
forge build --root src/contracts >/dev/null
DEPLOY_JSON=$(forge create --root src/contracts --rpc-url "$RPC_URL" --private-key "$WRITER_KEY" \
  --broadcast --json src/AnchorDataEdge.sol:AnchorDataEdge)
CONTRACT=$(echo "$DEPLOY_JSON" | jq -r .deployedTo)
DEPLOY_TX=$(echo "$DEPLOY_JSON" | jq -r .transactionHash)
START_BLOCK=$(cast receipt --rpc-url "$RPC_URL" "$DEPLOY_TX" blockNumber)
echo "contract ${CONTRACT} at block ${START_BLOCK}"
[[ "$CONTRACT" =~ ^0x[0-9a-fA-F]{40}$ ]] && ok "contract deployed" || bad "deploy failed"

log "3 · anchor the fixture stream"
node dist/anchor-writer/cli.js post \
  --records fixtures/records.jsonl \
  --keystore fixtures/demo-keyfile.json \
  --contract "$CONTRACT" \
  --rpc "$RPC_URL" \
  --private-key "$WRITER_KEY" \
  --archive "${WORK}/archive.json" | tee "${LOGS}/post.log"
expect_output "seq 9" "${LOGS}/post.log" "all ten anchors submitted"

# Two extra on-chain cases the mapping must handle without dropping anything:
# a payload that is not an envelope, and an identical re-submission of seq 0.
JUNK_TX=$(cast send --rpc-url "$RPC_URL" --private-key "$WRITER_KEY" --json \
  "$CONTRACT" "postAnchor(bytes)" 0x0102030405 | jq -r .transactionHash)
DUPLICATE_ENVELOPE=$(jq -r '.anchors[0].envelope' "${WORK}/archive.json")
cast send --rpc-url "$RPC_URL" --private-key "$WRITER_KEY" --json \
  "$CONTRACT" "postAnchor(bytes)" "$DUPLICATE_ENVELOPE" >/dev/null
echo "junk payload tx ${JUNK_TX}; seq 0 re-submitted once"

node dist/anchor-writer/cli.js disclose \
  --archive "${WORK}/archive.json" \
  --records fixtures/records.jsonl \
  --keystore fixtures/demo-keyfile.json \
  --out "${WORK}/disclosure" >/dev/null
ok "disclosure bundle written"

stack_down() {
  docker compose -f "$COMPOSE" down -v --remove-orphans >>"${LOGS}/compose.log" 2>&1 || true
  # Docker frees published ports slightly after the containers disappear;
  # bringing the stack straight back up races that and fails to bind.
  for _ in $(seq 1 60); do
    lsof -nP -iTCP:15001 -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 1
  done
  return 1
}

stack_up() {
  docker compose -f "$COMPOSE" up -d >>"${LOGS}/compose.log" 2>&1
  for _ in $(seq 1 180); do
    if curl -sf "$GRAPH_ADMIN" -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"subgraph_list","params":{}}' >/dev/null 2>&1 &&
      curl -sf "$IPFS_URL/api/v0/version" -X POST >/dev/null 2>&1 &&
      curl -sf "$GRAPH_STATUS" -H 'content-type: application/json' -d '{"query":"{ __typename }"}' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker compose -f "$COMPOSE" logs --tail=40 >&2 || true
  return 1
}

log "4 · start the graph-node stack"
stack_up && ok "graph-node, ipfs and postgres are up" || { bad "stack did not come up"; exit 1; }

deploy_variant() { # name variant
  local name="$1" variant="$2" manifest
  manifest=$([[ "$variant" == honest ]] && echo "subgraph.yaml" || echo "subgraph.${variant}.yaml")
  node dist/tools/gen-manifest.js --variant "$variant" --network "$NETWORK_NAME" \
    --address "$CONTRACT" --start-block "$START_BLOCK" >/dev/null
  (cd src/subgraph && pnpm exec graph codegen "$manifest" >/dev/null 2>&1)
  (cd src/subgraph && pnpm exec graph create --node "$GRAPH_ADMIN" "$name" >/dev/null 2>&1 || true)
  (cd src/subgraph && pnpm exec graph deploy --node "$GRAPH_ADMIN" --ipfs "$IPFS_URL" \
    --version-label v0.1.0 "$name" "$manifest") >"${LOGS}/deploy-${name}.log" 2>&1
  grep -Eo 'Qm[1-9A-HJ-NP-Za-km-z]{44}' "${LOGS}/deploy-${name}.log" | tail -1
}

wait_synced() { # name
  local name="$1" query status
  query='{"query":"{ indexingStatusesForSubgraphName(subgraphName: \"'"$name"'\") { synced health fatalError { message } chains { latestBlock { number hash } } } }"}'
  for _ in $(seq 1 180); do
    status=$(curl -sf "$GRAPH_STATUS" -H 'content-type: application/json' -d "$query" || true)
    if [[ "$(echo "$status" | jq -r '.data.indexingStatusesForSubgraphName[0].synced // false')" == "true" ]]; then
      echo "$status" >"${LOGS}/status-${name}.json"
      return 0
    fi
    if [[ "$(echo "$status" | jq -r '.data.indexingStatusesForSubgraphName[0].health // "healthy"')" == "failed" ]]; then
      echo "$status" | jq . >&2
      return 1
    fi
    sleep 1
  done
  echo "$status" | jq . >&2
  return 1
}

latest_indexed_block() { # name
  curl -sf "$GRAPH_STATUS" -H 'content-type: application/json' \
    -d '{"query":"{ indexingStatusesForSubgraphName(subgraphName: \"'"$1"'\") { chains { latestBlock { number } } } }"}' \
    | jq -r '.data.indexingStatusesForSubgraphName[0].chains[0].latestBlock.number // 0'
}

# `synced` means "caught up with the chain head the ingestor currently knows",
# which can still be a block or two behind a freshly mined head. Every
# block-pinned query needs the height itself, so wait for it explicitly.
wait_block() { # name blockNumber
  local name="$1" target="$2" current
  for _ in $(seq 1 240); do
    current=$(latest_indexed_block "$name")
    [[ "$current" -ge "$target" ]] && return 0
    sleep 1
  done
  echo "subgraph ${name} stalled at block ${current}, needed ${target}" >&2
  curl -sf "$GRAPH_STATUS" -H 'content-type: application/json' \
    -d '{"query":"{ indexingStatusesForSubgraphName(subgraphName: \"'"$name"'\") { synced health entityCount fatalError { message block { number } } nonFatalErrors { message } chains { chainHeadBlock { number } latestBlock { number } } } }"}' \
    | jq . >&2 || true
  docker compose -f "$COMPOSE" logs --tail=60 graph-node >&2 || true
  return 1
}

log "5 · index with the call-handler subgraph"
HONEST_DEPLOYMENT=$(deploy_variant anchor-data-edge honest)
wait_synced anchor-data-edge && ok "honest subgraph synced (${HONEST_DEPLOYMENT})" || bad "honest subgraph did not sync"
PINNED_BLOCK=$(cast block-number --rpc-url "$RPC_URL")
PINNED_HASH=$(cast block --rpc-url "$RPC_URL" "$PINNED_BLOCK" --json | jq -r .hash)
wait_block anchor-data-edge "$PINNED_BLOCK" && ok "honest subgraph reached the pinned block" || bad "honest subgraph never reached block ${PINNED_BLOCK}"
echo "pinned at block ${PINNED_BLOCK} (${PINNED_HASH})"

log "6 · reconcile: served index vs disclosure"
expect_exit 0 "checker --source local exits 0" \
  node dist/completeness-checker/cli.js verify \
    --disclosure "${WORK}/disclosure" --source local \
    --endpoint "${GRAPH_QUERY}/anchor-data-edge" --block "$PINNED_BLOCK" \
    --json "${WORK}/verdict-local.json"
expect_output "MALFORMED" "${LOGS}/last-command.log" "the junk payload is reported, not dropped"
expect_output "DUPLICATE" "${LOGS}/last-command.log" "the identical re-submission is reported as a duplicate"

log "7 · reconcile: raw block scan (no Graph component in the trust path)"
expect_exit 0 "checker --source chain exits 0" \
  node dist/completeness-checker/cli.js verify \
    --disclosure "${WORK}/disclosure" --source chain --rpc "$RPC_URL" \
    --to-block "$PINNED_BLOCK" --json "${WORK}/verdict-chain.json"

log "8 · cross-check: served index vs raw block scan, entity for entity"
expect_exit 0 "local index agrees with the chain scan" \
  node dist/completeness-checker/cli.js verify \
    --disclosure "${WORK}/disclosure" --source local \
    --endpoint "${GRAPH_QUERY}/anchor-data-edge" --block "$PINNED_BLOCK" \
    --cross-check-chain --rpc "$RPC_URL" --to-block "$PINNED_BLOCK"
expect_output "agrees entity-for-entity" "${LOGS}/last-command.log" "cross-check reports agreement"

log "9 · tamper: a restated record"
node dist/tools/tamper.js alter --disclosure "${WORK}/disclosure" --out "${WORK}/disclosure-altered" --seq 3
expect_exit 2 "altered disclosure fails with ALTERED" \
  node dist/completeness-checker/cli.js verify \
    --disclosure "${WORK}/disclosure-altered" --source local \
    --endpoint "${GRAPH_QUERY}/anchor-data-edge" --block "$PINNED_BLOCK"
expect_output "ALTERED seq=3" "${LOGS}/last-command.log" "names the altered position"

log "10 · tamper: a suppressed record"
node dist/tools/tamper.js suppress --disclosure "${WORK}/disclosure" --out "${WORK}/disclosure-suppressed" --seq 5
expect_exit 3 "suppressed disclosure fails with MISSING" \
  node dist/completeness-checker/cli.js verify \
    --disclosure "${WORK}/disclosure-suppressed" --source local \
    --endpoint "${GRAPH_QUERY}/anchor-data-edge" --block "$PINNED_BLOCK"
expect_output "MISSING seq=5" "${LOGS}/last-command.log" "names the suppressed position"
expect_output "COUNT-MISMATCH" "${LOGS}/last-command.log" "reports the count mismatch too"

log "11 · bad server: an index that withholds anchors"
GAP_DEPLOYMENT=$(deploy_variant anchor-data-edge-gap badserver-gap)
wait_synced anchor-data-edge-gap && wait_block anchor-data-edge-gap "$PINNED_BLOCK" \
  && ok "gap variant synced (${GAP_DEPLOYMENT})" || bad "gap variant did not sync"
expect_exit 4 "incomplete server fails with GAP" \
  node dist/completeness-checker/cli.js verify \
    --disclosure "${WORK}/disclosure" --source local \
    --endpoint "${GRAPH_QUERY}/anchor-data-edge-gap" --block "$PINNED_BLOCK"
expect_output "GAP seq=3" "${LOGS}/last-command.log" "names the first withheld position"
expect_output "GAP seq=7" "${LOGS}/last-command.log" "names the second withheld position"

log "12 · bad server: an index that breaks the hash chain"
CHAIN_DEPLOYMENT=$(deploy_variant anchor-data-edge-chainbreak badserver-chain)
wait_synced anchor-data-edge-chainbreak && wait_block anchor-data-edge-chainbreak "$PINNED_BLOCK" \
  && ok "chain-break variant synced (${CHAIN_DEPLOYMENT})" || bad "chain-break variant did not sync"
expect_exit 5 "broken chain fails with CHAIN-BREAK" \
  node dist/completeness-checker/cli.js verify \
    --disclosure "${WORK}/disclosure" --source local \
    --endpoint "${GRAPH_QUERY}/anchor-data-edge-chainbreak" --block "$PINNED_BLOCK"
expect_output "CHAIN-BREAK seq=5" "${LOGS}/last-command.log" "names the broken link"

log "13 · determinism: entity set and POI after a from-scratch re-index"
poi_query() { # deployment blockNumber blockHash
  printf '{"query":"{ proofOfIndexing(subgraph: \\"%s\\", blockNumber: %s, blockHash: \\"%s\\") }"}' "$1" "$2" "$3"
}
entity_dump() { # endpoint block outfile
  curl -sf "$1" -H 'content-type: application/json' -d '{"query":"{ anchors(orderBy: seq, orderDirection: asc, first: 1000, block: {number: '"$2"'}) { id seq ciphertextDigest prevEnvelopeDigest envelopeDigest envelope submitter txHash blockNumber duplicateCount } streams(block: {number: '"$2"'}) { id anchorCount latestSeq headEnvelopeDigest hasConflicts conflictCount firstBlock lastBlock } malformedAnchors(block: {number: '"$2"'}) { id reason payloadLength payload } }"}' \
    | jq -S . >"$3"
}

entity_dump "${GRAPH_QUERY}/anchor-data-edge" "$PINNED_BLOCK" "${WORK}/entities-run1.json"
curl -sf "$GRAPH_STATUS" -H 'content-type: application/json' \
  -d "$(poi_query "$HONEST_DEPLOYMENT" "$PINNED_BLOCK" "$PINNED_HASH")" | jq -r '.data.proofOfIndexing' >"${WORK}/poi-run1.txt"
echo "run 1 POI: $(cat "${WORK}/poi-run1.txt")"

stack_down && ok "wiped the graph-node database" || bad "stack teardown did not release its ports"
stack_up || { bad "stack did not come back up"; exit 1; }
REDEPLOYED=$(deploy_variant anchor-data-edge honest)
[[ "$REDEPLOYED" == "$HONEST_DEPLOYMENT" ]] \
  && ok "re-deploy produced the same deployment id (${REDEPLOYED})" \
  || bad "re-deploy produced a different deployment id: ${REDEPLOYED} != ${HONEST_DEPLOYMENT}"
wait_synced anchor-data-edge && wait_block anchor-data-edge "$PINNED_BLOCK" \
  && ok "re-indexed from an empty database (${REDEPLOYED})" || bad "re-index did not reach the pinned block"

entity_dump "${GRAPH_QUERY}/anchor-data-edge" "$PINNED_BLOCK" "${WORK}/entities-run2.json"
curl -sf "$GRAPH_STATUS" -H 'content-type: application/json' \
  -d "$(poi_query "$REDEPLOYED" "$PINNED_BLOCK" "$PINNED_HASH")" | jq -r '.data.proofOfIndexing' >"${WORK}/poi-run2.txt"
echo "run 2 POI: $(cat "${WORK}/poi-run2.txt")"

if diff -q "${WORK}/entities-run1.json" "${WORK}/entities-run2.json" >/dev/null; then
  ok "entity set is identical across a from-scratch re-index"
else
  bad "entity set changed across re-index"
  diff "${WORK}/entities-run1.json" "${WORK}/entities-run2.json" | head -40
fi

POI1=$(cat "${WORK}/poi-run1.txt")
POI2=$(cat "${WORK}/poi-run2.txt")
if [[ -n "$POI1" && "$POI1" != "null" && "$POI1" == "$POI2" ]]; then
  ok "POI is identical across a from-scratch re-index (${POI1})"
elif [[ "$POI1" == "null" || -z "$POI1" ]]; then
  bad "POI could not be read from the status API (got '${POI1}')"
else
  bad "POI changed across re-index: ${POI1} != ${POI2}"
fi

log "summary"
printf '%s passed, %s failed\n' "$PASSES" "$FAILURES"
[[ "$FAILURES" == "0" ]]
