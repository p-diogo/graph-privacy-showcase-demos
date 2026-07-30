#!/usr/bin/env bash
# Full local audit path against the real stack.
#
#   anvil -> EthSystems' PrivateBond -> graph-node (call handlers)
#         -> gateway shim -> bond-replay
#
# This is the test that proves the parts the hermetic Rust tests cannot: root
# replay against on-chain `knownRoots`, the storage cross-check, and the three
# tripwires failing in three different places.
#
# LOCAL ONLY. Nothing here touches a public network, publishes a subgraph, or
# spends anything. The gateway shim is NOT a gateway: its attestations are
# signed by throwaway keys with no stake, so a green run here is evidence that
# the audit path works, and no evidence at all about the decentralized network.
#
# Requires: Docker, Foundry, Rust, Node.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ITEM_ROOT="$(cd "$HERE/../.." && pwd)"
BUILD_DIR="$ITEM_ROOT/build"
REPLAY="$ITEM_ROOT/src/replay"
SUBGRAPH="$ITEM_ROOT/src/subgraph"

RPC_URL="http://127.0.0.1:8545"
GRAPH_NODE_QUERY="http://127.0.0.1:8000/subgraphs/name/private-bond-anchors"
GRAPH_NODE_ADMIN="http://127.0.0.1:8020"
IPFS="http://127.0.0.1:5001"
MOCK_GATEWAY_PORT=8999
MOCK_GATEWAY="http://127.0.0.1:$MOCK_GATEWAY_PORT"

MOCK_PID=""
pass_count=0
fail_count=0

# This script owns the whole local stack for the duration of a run, and it is
# safe to run back to back. Both halves of that matter: it tears down anything
# it left behind before starting, and again on the way out.
#
# Without the anvil teardown a second consecutive run silently deploys onto the
# first run's chain, whose clock is already past maturity, and fails with
# "Bond A already matured" — an error that points nowhere near the cause.
teardown_stack() {
  pkill -f "anvil --port 8545" 2>/dev/null || true
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  docker compose -f "$HERE/docker-compose.yml" down -v >/dev/null 2>&1 || true
  return 0
}

cleanup() {
  teardown_stack
}
trap cleanup EXIT

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; pass_count=$((pass_count + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail_count=$((fail_count + 1)); }

# ---------------------------------------------------------------------------
step "0 · tear down anything a previous run left behind"
teardown_stack
# Wait for the port to actually free, or the new anvil loses the race to bind.
for _ in $(seq 1 50); do
  cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 || break
  sleep 0.2
done
if cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "FATAL: something else is holding $RPC_URL and this script did not start it." >&2
  echo "Stop it before running the end-to-end." >&2
  exit 1
fi
ok "no leftover chain on $RPC_URL"

# ---------------------------------------------------------------------------
step "1 · seed a fresh local chain"
KEEP_ANVIL=1 "$ITEM_ROOT/src/seed/seed-local.sh" > "$BUILD_DIR/seed.log" 2>&1 || {
  echo "seed failed; see $BUILD_DIR/seed.log"; tail -30 "$BUILD_DIR/seed.log"; exit 1;
}
BOND_ADDR="$(jq -r .privateBond "$BUILD_DIR/deployment.json")"
ok "chain seeded, PrivateBond at $BOND_ADDR"

# ---------------------------------------------------------------------------
step "2 · bring up graph-node on a clean store"
# The store must be wiped whenever the chain is recreated. graph-node caches
# block hashes per network name, and a fresh anvil reuses block numbers with
# different hashes; the ingestor then reports "Provider went backwards" and
# refuses to advance, forever. Reusing a store across chains is not a
# recoverable state, so this always starts clean.
docker compose -f "$HERE/docker-compose.yml" down -v >/dev/null 2>&1 || true
docker compose -f "$HERE/docker-compose.yml" up -d >/dev/null 2>&1
until curl -s -o /dev/null "http://127.0.0.1:8030/graphql" 2>/dev/null; do
  sleep 2
done
ok "graph-node responding"

# ---------------------------------------------------------------------------
step "3 · deploy the call-handler subgraph"
jq '{network: "mainnet", address: .privateBond, startBlock: 0}' \
  "$BUILD_DIR/deployment.json" > "$BUILD_DIR/subgraph-config.json"

cd "$SUBGRAPH"
npx mustache "$BUILD_DIR/subgraph-config.json" subgraph.yaml > subgraph.local.yaml
npx graph codegen subgraph.local.yaml >/dev/null 2>&1
npx graph create --node "$GRAPH_NODE_ADMIN" private-bond-anchors >/dev/null 2>&1 || true
DEPLOY_OUT="$(npx graph deploy --node "$GRAPH_NODE_ADMIN" --ipfs "$IPFS" \
  --version-label "e2e-$(date +%s)" private-bond-anchors subgraph.local.yaml 2>&1)"
DEPLOYMENT_ID="$(echo "$DEPLOY_OUT" | grep -oE 'Qm[1-9A-HJ-NP-Za-km-z]{44}' | head -1)"
[ -n "$DEPLOYMENT_ID" ] || { echo "could not determine deployment id"; echo "$DEPLOY_OUT"; exit 1; }
ok "deployed $DEPLOYMENT_ID"

step "4 · wait for the anchor log to be served"
until curl -s -X POST -H 'content-type: application/json' \
        --data '{"query":"{commitments{id}}"}' "$GRAPH_NODE_QUERY" 2>/dev/null \
      | grep -q '000000000007'; do
  sleep 2
done
SERVED_LEAVES="$(curl -s -X POST -H 'content-type: application/json' \
  --data '{"query":"{bonds{leafCount}}"}' "$GRAPH_NODE_QUERY" | jq -r '.data.bonds[0].leafCount')"
[ "$SERVED_LEAVES" = "8" ] && ok "8 leaves served" || bad "expected 8 leaves, got $SERVED_LEAVES"

# ---------------------------------------------------------------------------
step "5 · start the gateway shim"
cd "$REPLAY"
cargo build --release --quiet
./target/release/mock-gateway \
  --upstream "$GRAPH_NODE_QUERY" \
  --deployment "$DEPLOYMENT_ID" \
  --port "$MOCK_GATEWAY_PORT" \
  --indexers 2 > "$BUILD_DIR/mock-gateway.log" 2>&1 &
MOCK_PID=$!
until curl -s -o /dev/null "$MOCK_GATEWAY/api/deployments/id/$DEPLOYMENT_ID" \
        -X POST -H 'content-type: application/json' --data '{"query":"{_meta{block{number}}}"}'; do
  sleep 1
done
ok "shim up (NOT a gateway; throwaway keys, no stake)"

CLI="./target/release/bond-replay"
COMMON=(--bundle "$BUILD_DIR/audit-bundle.json"
        --manifest "$BUILD_DIR/records-manifest.json"
        --records-dir "$BUILD_DIR/records")

# ---------------------------------------------------------------------------
step "6 · fetch an attested anchor set"
if $CLI fetch --gateway "$MOCK_GATEWAY" --deployment "$DEPLOYMENT_ID" \
     --out "$BUILD_DIR/audit-bundle.json" > "$BUILD_DIR/fetch.log" 2>&1; then
  ok "fetched and saved an attested bundle"
else
  bad "fetch failed"; tail -20 "$BUILD_DIR/fetch.log"
fi

step "7 · verify the attestation offline"
if $CLI verify-attestation --bundle "$BUILD_DIR/audit-bundle.json" > "$BUILD_DIR/verify.log" 2>&1; then
  # Deliberately not "signed by a staked allocation": in this run the signer is
  # the shim's throwaway key, which resolves to no allocation and no stake. The
  # mechanism is what is being demonstrated, not the economic backing.
  ok "attestation verified offline (signature over these exact bytes; NOT a validity proof, and this signer holds no stake)"
else
  bad "attestation verification failed"; cat "$BUILD_DIR/verify.log"
fi

# ---------------------------------------------------------------------------
step "8 · reconcile against the served anchors and the chain"
if $CLI reconcile "${COMMON[@]}" \
     --rpc-url "$RPC_URL" --contract "$BOND_ADDR" --verify-onchain \
     --report "$BUILD_DIR/reconcile-report.json" > "$BUILD_DIR/reconcile.log" 2>&1; then
  ok "full reconciliation green (records, accounting, root replay, storage)"
  ROOTS_OK="$(jq '[.root_replay[] | select(.known_on_chain == true)] | length' "$BUILD_DIR/reconcile-report.json")"
  ROOTS_ALL="$(jq '.root_replay | length' "$BUILD_DIR/reconcile-report.json")"
  [ "$ROOTS_OK" = "$ROOTS_ALL" ] && ok "$ROOTS_OK/$ROOTS_ALL rebuilt roots found in knownRoots" \
                                 || bad "only $ROOTS_OK/$ROOTS_ALL roots matched knownRoots"
else
  bad "reconciliation failed"; tail -40 "$BUILD_DIR/reconcile.log"
fi

step "9 · the report is byte-identical when re-run"
$CLI reconcile "${COMMON[@]}" --rpc-url "$RPC_URL" --contract "$BOND_ADDR" \
  --report "$BUILD_DIR/reconcile-a.json" >/dev/null 2>&1 || true
$CLI reconcile "${COMMON[@]}" --rpc-url "$RPC_URL" --contract "$BOND_ADDR" \
  --report "$BUILD_DIR/reconcile-b.json" >/dev/null 2>&1 || true
if diff -q "$BUILD_DIR/reconcile-a.json" "$BUILD_DIR/reconcile-b.json" >/dev/null; then
  ok "two runs produced byte-identical reports"
else
  bad "reports differ between runs"; diff "$BUILD_DIR/reconcile-a.json" "$BUILD_DIR/reconcile-b.json" | head -20
fi

# ---------------------------------------------------------------------------
step "10 · tripwire 1 — an altered disclosed record"
RECORD="$(jq -r '[.entries[] | select(.record_file != null)][2].record_file' "$BUILD_DIR/records-manifest.json")"
if $CLI tamper --tripwire altered-record --record "$RECORD" --field value \
     "${COMMON[@]}" --rpc-url "$RPC_URL" --contract "$BOND_ADDR" \
     > "$BUILD_DIR/tamper-1.log" 2>&1; then
  grep -q 'TAMPERING CAUGHT' "$BUILD_DIR/tamper-1.log" \
    && ok "altered record caught by reconciliation, record named" \
    || bad "tripwire 1 did not report a catch"
else
  bad "tripwire 1 run failed"; tail -20 "$BUILD_DIR/tamper-1.log"
fi

step "11 · tripwire 2 — an altered response byte"
if $CLI tamper --tripwire altered-response-byte "${COMMON[@]}" \
     > "$BUILD_DIR/tamper-2.log" 2>&1; then
  grep -q 'TAMPERING CAUGHT' "$BUILD_DIR/tamper-2.log" \
    && ok "altered bytes caught by the attestation (responseCID mismatch)" \
    || bad "tripwire 2 did not report a catch"
else
  bad "tripwire 2 run failed"; tail -20 "$BUILD_DIR/tamper-2.log"
fi

step "12 · tripwire 3 — a lying serving layer that signs its own alteration"
if $CLI tamper --tripwire resigned-altered-anchors "${COMMON[@]}" \
     --rpc-url "$RPC_URL" --contract "$BOND_ADDR" \
     > "$BUILD_DIR/tamper-3.log" 2>&1; then
  if grep -q 'TAMPERING CAUGHT' "$BUILD_DIR/tamper-3.log" \
     && grep -q 'attestation verification: PASS' "$BUILD_DIR/tamper-3.log"; then
    ok "valid attestation over altered anchors, caught by root replay against the chain"
  else
    bad "tripwire 3 did not isolate to root replay"; tail -30 "$BUILD_DIR/tamper-3.log"
  fi
else
  bad "tripwire 3 run failed"; tail -30 "$BUILD_DIR/tamper-3.log"
fi

# ---------------------------------------------------------------------------
step "results"
printf '  %d passed, %d failed\n' "$pass_count" "$fail_count"
if [ "$fail_count" -ne 0 ]; then
  exit 1
fi
printf '\n  Scope: the shim is not a gateway and its signers hold no stake.\n'
printf '  This run evidences the audit path only. Network serving is untested here.\n'
