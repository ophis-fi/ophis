#!/usr/bin/env bash
# infra/robinhood-mainnet/nitro/verify-snapshot.sh
#
# TRUST GATE for a restored (possibly untrusted) Nitro snapshot, BEFORE Ophis is
# allowed to trust a single trace from this node. Run it after restore-snapshot.sh
# has staged the data dir AND the node has been started once so it serves RPC on
# :8547 (it will follow the tip from the snapshot height).
#
# WHAT THIS CAN AND CANNOT PROVE (read this - it is the whole point):
#
#   CAN prove: the node's HEADER CHAIN is canonical. We take confirmed assertions
#   from the L2's Rollup contract on ETHEREUM L1 (AssertionConfirmed emits the
#   canonical (blockHash, sendRoot) for an L2 height), and check the node returns
#   the SAME block hash at that height. An L1-anchored match means the snapshot's
#   header chain is the real Robinhood chain up to the last confirmed assertion.
#   We also cross-check recent block hashes against the public RPC.
#
#   CANNOT prove: that the flat STATE behind those headers is honest. Verified in
#   the Geth/Nitro source (core/state/database.go, CachingDB.Reader): state reads
#   hit the flat snapshot layer first and it does NOT re-hash values against the
#   header stateRoot. So a snapshot with tampered balances/storage/code can serve
#   silently-wrong traces even while every block hash matches. There is no cheap
#   local check that closes this; the only real defenses are (a) a trusted
#   publisher, or (b) re-deriving state from DA, which the blob gap makes
#   impossible here. Passing this gate lowers, but does not eliminate, the risk of
#   an anonymous snapshot. Weigh that before pointing settlement at this leg.
#
# NOT YET RUN - authored 2026-07-22. Requires `cast` (foundry) + jq + curl.
set -euo pipefail

NODE_RPC="${NODE_RPC:-http://127.0.0.1:8547}"
PUBLIC_RPC="${PUBLIC_RPC:-https://rpc.mainnet.chain.robinhood.com}"
L1_RPC="${L1_RPC:?set L1_RPC to an Ethereum mainnet RPC that serves eth_getLogs (e.g. https://eth.drpc.org)}"
ROLLUP="${ROLLUP:-0x23A19d23e89166adedbDcB432518AB01e4272D94}"
SAMPLES="${SAMPLES:-8}"          # recent-block hashes to cross-check vs public RPC

log(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok(){  printf '\033[32m  PASS: %s\033[0m\n' "$*"; }
bad(){ printf '\033[31m  FAIL: %s\033[0m\n' "$*"; FAILED=1; }
for t in cast jq curl; do command -v "$t" >/dev/null || { echo "missing $t"; exit 2; }; done
FAILED=0

# ── 0. node is up and on the right chain ──────────────────────────────────────
log "Node identity"
CID="$(cast chain-id --rpc-url "$NODE_RPC")" || { echo "node not reachable at $NODE_RPC"; exit 2; }
[[ "$CID" == "4663" ]] && ok "chainId 4663" || bad "chainId is $CID, expected 4663"
NODE_HEAD="$(cast block-number --rpc-url "$NODE_RPC")"; echo "  node head: $NODE_HEAD"

# ── 1. cross-check recent block hashes against the public RPC ──────────────────
# Cheap sanity that the node is on the same chain the public endpoint sees. Uses
# blocks a little behind tip so both nodes have certainly seen them.
log "Cross-checking $SAMPLES recent block hashes vs public RPC"
PUB_HEAD="$(cast block-number --rpc-url "$PUBLIC_RPC")"
BASE=$(( (NODE_HEAD < PUB_HEAD ? NODE_HEAD : PUB_HEAD) - 50 ))
for i in $(seq 0 $((SAMPLES-1))); do
  h=$(( BASE - i*500 )); [[ $h -gt 0 ]] || break
  nh="$(cast block "$h" --rpc-url "$NODE_RPC"   --json | jq -r '.hash')"
  ph="$(cast block "$h" --rpc-url "$PUBLIC_RPC" --json | jq -r '.hash')"
  if [[ "$nh" == "$ph" && -n "$nh" ]]; then ok "block $h hash matches ($nh)"; else bad "block $h: node=$nh public=$ph"; fi
done

# ── 2. L1 ANCHOR: confirmed assertions from the Rollup on Ethereum L1 ─────────
# This is the strong check. AssertionConfirmed(bytes32 indexed assertionHash,
# bytes32 blockHash, bytes32 sendRoot) is emitted on L1 when the L2 state at some
# height is confirmed. cast computes the topic0 for us; we take the latest few and
# verify the node's block hash equals the L1-published blockHash.
log "L1 anchor: reading AssertionConfirmed from rollup $ROLLUP on Ethereum L1"
TOPIC0="$(cast sig-event 'AssertionConfirmed(bytes32,bytes32,bytes32)')"
echo "  topic0: $TOPIC0"
L1_HEAD="$(cast block-number --rpc-url "$L1_RPC")"
FROM=$(( L1_HEAD - 100000 ))     # ~2 weeks of L1; assertions are periodic, not per-block
LOGS="$(cast logs --rpc-url "$L1_RPC" --from-block "$FROM" --to-block latest \
        --address "$ROLLUP" "$TOPIC0" --json 2>/dev/null || echo '[]')"
NLOG="$(echo "$LOGS" | jq 'length')"
echo "  found $NLOG AssertionConfirmed events in the last 100k L1 blocks"
if [[ "$NLOG" -eq 0 ]]; then
  bad "no AssertionConfirmed events found - widen FROM, or the ABI/topic differs for this rollup version; verify manually before trusting"
else
  # data = 0x || blockHash(32) || sendRoot(32). Decode and check the node.
  echo "$LOGS" | jq -c '.[-3:][]' | while read -r ev; do
    data="$(echo "$ev" | jq -r '.data')"
    bh="0x${data:2:64}"
    # Ask the node for a block WITH this hash; must exist and be canonical.
    got="$(cast block "$bh" --rpc-url "$NODE_RPC" --json 2>/dev/null | jq -r '.hash // empty')"
    if [[ "$got" == "$bh" ]]; then
      num="$(cast block "$bh" --rpc-url "$NODE_RPC" --json | jq -r '.number')"
      ok "L1-confirmed blockHash $bh present in node at height $((num))"
    else
      bad "L1-confirmed blockHash $bh NOT found in node - snapshot header chain diverges from L1 truth"
    fi
  done
fi

# ── 3. trace actually works on a near-tip tx ──────────────────────────────────
log "debug_traceTransaction on a near-tip tx (the reason this node exists)"
TX="$(cast block latest --rpc-url "$NODE_RPC" --json | jq -r '.transactions[0] // empty')"
if [[ -z "$TX" ]]; then
  echo "  latest block had no txs; trying a few back"
  for b in 1 2 3 4 5; do TX="$(cast block $((NODE_HEAD-b)) --rpc-url "$NODE_RPC" --json | jq -r '.transactions[0] // empty')"; [[ -n "$TX" ]] && break; done
fi
if [[ -n "$TX" ]]; then
  if cast rpc debug_traceTransaction "$TX" '{"tracer":"callTracer"}' --rpc-url "$NODE_RPC" >/dev/null 2>&1; then
    ok "debug_traceTransaction returned a trace for $TX"
  else
    bad "debug_traceTransaction failed for $TX - check the 'debug' namespace is enabled and the tx is near-tip"
  fi
else
  echo "  (no recent tx found to trace; re-run when the chain has traffic)"
fi

# ── verdict ───────────────────────────────────────────────────────────────────
echo
if [[ "$FAILED" -eq 0 ]]; then
  printf '\033[32m==> GATE PASSED (header chain L1-anchored, trace works).\033[0m\n'
  cat <<'EOF'
  Residual risk remains: this proves the HEADER chain, not the flat STATE DB (see
  the header comment). If the snapshot publisher is untrusted, treat every trace
  from this leg as only as trustworthy as that publisher, and keep >=2 independent
  legs in eRPC so this node is a voter, never a sole authority.
EOF
  exit 0
else
  printf '\033[31m==> GATE FAILED. Do NOT point Ophis settlement at this node.\033[0m\n'
  exit 1
fi
