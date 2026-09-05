#!/usr/bin/env python3
"""Fail-closed guard for the Ophis Optimism eRPC config (#447).

Runs in CI against infra/optimism-mainnet/configs/erpc.yaml.tmpl. The rendered
config is byte-identical in consensus/upstream STRUCTURE (render-configs.sh's
envsubst only swaps `${VAR}` string values), so validating the template proves
the same invariants without parsing secrets.

CLOSED-WORLD design: eRPC's config surface is large and evolving (directives,
tiers, finality parsing, per-scope method filters, skipConsensus, selection
policies, ...). Rather than allow arbitrary configs and try to prove each is
fail-closed (an unwinnable whack-a-mole — see Codex #464 rounds 1-7), this guard
pins the known-good KEY SCHEMA of the chain-10 consensus/upstream surface and
REJECTS any key it does not explicitly recognize. So `skipConsensus`, `tier`,
`matchFinality`, `allowMethods`/`ignoreMethods`, `ignoreFields`, `prefer*`, etc.
all fail closed by construction — a future eRPC field can weaken consensus only
after this allowlist is deliberately extended in review.

WHY CI, NOT render-configs.sh: wiring PyYAML into the operator/DR render path
would make a stack restart fail on a host without PyYAML — worse than the
weakening it guards against (Codex #464 P1). Template edits go through PRs.

On top of the schema lock it asserts the value invariants: exactly the 3 expected
independent upstream hosts; every Block A+B settlement-relevant method's
first-matching failsafe rule is a consensus rule with maxParticipants:3,
agreementThreshold:2, lowParticipants:returnError (always fail-closed on an
outage) and dispute in {returnError, preferBlockHeadLeader} (the latter only
breaks 1-block tip-drift ties among upstreams that DID respond — see #476);
every consensus rule fail-closed; matchMethod uses only the modelled `*`/`|`
matcher.
"""
import re
import sys
from urllib.parse import urlsplit

import yaml

CHAIN_ID = 10
EXPECTED_UPSTREAMS = 3
# The 3 intended INDEPENDENT failure domains, pinned by hostname so a sibling host,
# IP-literal, or extra provider cannot pose as a 3rd domain. A deliberate provider
# change MUST update this set (that is the point — see module docstring).
#
# 2026-08-11: alchemy-op -> ophis-self-op. Alchemy's shared free monthly quota
# exhausted two days after it joined the quorum, recreating the exact
# low-participants outage it was meant to prevent. The replacement is Ophis's
# synced Aleph op-reth node, reached only over Tailscale. It has no provider
# quota and was verified against every protected method before admission.
#
# The "≤1 Cloudflare-fronted upstream per quorum" property is PRESERVED:
# publicnode is the one CF lane, while zan (no CDN) and official-op (GCP LB,
# `via: 1.1 google`) are non-CF failure domains, so a single CDN compromise
# cannot forge 2-of-3.
#
# Thin-method note: publicnode's free tier is archive-gated, so it can serve
# NEITHER eth_getTransactionReceipt NOR eth_getLogs deeper than ~128 blocks from
# head. Both therefore run 2-of-3 on zan+official-op, which is why the template's
# receipt rule is disputeBehavior:returnError (fail closed).
# This guard's consensus-parameter assertions are unchanged.
#
# 2026-08-15: the self-hosted lane 100.90.108.54 was retired after its Aleph VM
# died with its host and blocked the whole network policy for 23h (a dead lane at
# routing priority 1 outlasts the 12s network budget). Replaced by validationcloud.
#
# 2026-08-23: validationcloud-op was retired after returning HTTP 401 from 08-18
# (its third credential/quota death: 07-30, 08-18, this one). With it gone, the
# only lane that could serve archive eth_getLogs was zan — 1 of 3, BELOW
# agreementThreshold — so the autopilot's settlement indexer wedged permanently
# once it fell past publicnode's ~128-block archive gate. Replaced by official-op
# (mainnet.optimism.io): non-CF, archive-capable, no quota to exhaust.
EXPECTED_UPSTREAM_HOSTS = frozenset({
    "lb.drpc.org",
    "api.zan.top",
    "optimism.gateway.tenderly.co",
})
# Settlement-relevant reads that MUST keep a fail-closed-consensus first-match —
# mirror the template's consensus rules. Block A/B sit in punished consensus
# blocks. eth_getTransactionReceipt is ALSO required under consensus (it's
# settlement-authoritative — the driver derives Executed/Reverted from it) but
# lives in its OWN rule WITHOUT punishMisbehavior so the self-node's empty-receipt
# lag can't cordon it (Codex #465/#466). This guard checks the consensus PARAMS
# (maxParticipants/threshold/behaviors), not punishMisbehavior, so the no-punish
# receipt rule satisfies it while a single forged receipt still can't reach quorum.
BLOCK_A = ("eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt")
BLOCK_B = ("eth_getLogs", "eth_getTransactionByHash",
           "eth_estimateGas", "eth_feeHistory", "eth_getTransactionCount")
RECEIPT = ("eth_getTransactionReceipt",)
PROTECTED_METHODS = BLOCK_A + BLOCK_B + RECEIPT

# Allowed keys per structural level of the chain-10 consensus/upstream surface.
# Any key outside these sets fails closed (the whole point — see module docstring).
ALLOWED = {
    "project": {"id", "networks", "upstreamDefaults", "upstreams"},
    "upstreamDefaults": {"evm"},
    "upstreamDefaults.evm": {"statePollerDebounce", "statePollerInterval"},
    "network": {"architecture", "evm", "failsafe"},
    "network.evm": {"chainId", "integrity"},
    "integrity": {"enforceHighestBlock", "enforceNonNullTaggedBlocks"},
    "rule": {"matchMethod", "timeout", "consensus", "retry", "hedge"},
    "consensus": {"agreementThreshold", "disputeBehavior", "lowParticipantsBehavior", "maxParticipants", "punishMisbehavior"},
    "punishMisbehavior": {"disputeThreshold", "disputeWindow", "sitOutPenalty"},
    "retry": {"backoffFactor", "backoffMaxDelay", "delay", "jitter", "maxAttempts"},
    "timeout": {"duration"},
    "hedge": {"delay", "maxCount"},
    "upstream": {"endpoint", "failsafe", "id"},
    "upstream_rule": {"matchMethod", "timeout", "retry", "circuitBreaker"},
    "circuitBreaker": {"failureThresholdCount", "failureThresholdCapacity", "halfOpenAfter", "successThresholdCount", "successThresholdCapacity"},
}

_SEGMENT_OK = re.compile(r"^[A-Za-z0-9_*]*$")
EXIT_FAIL = 14


def _check_keys(node, level, path, errs):
    if not isinstance(node, dict):
        errs.append(f"{path}: expected a mapping, got {type(node).__name__}")
        return
    unknown = sorted(k for k in node if k not in ALLOWED[level])
    if unknown:
        errs.append(f"{path}: unrecognized key(s) {unknown} — closed-world guard refuses to certify config surface it does not model (allowed here: {sorted(ALLOWED[level])})")


def _modellable(pattern):
    if pattern is None:
        return True
    return all(_SEGMENT_OK.match(seg.strip()) for seg in str(pattern).split("|"))


def _method_matches(method, pattern):
    """eRPC matchMethod: ONLY `*` is a wildcard (?/[/] are literal); `|` alternation."""
    if pattern is None:
        return True
    for alt in str(pattern).split("|"):
        alt = alt.strip()
        if alt and re.fullmatch(".*".join(re.escape(p) for p in alt.split("*")), method):
            return True
    return False


def _hostname(endpoint):
    s = str(endpoint)
    try:
        return (urlsplit(s).hostname or s.strip().rstrip("/")).lower()
    except Exception:
        return s.lower()


def _consensus_failclosed(c):
    """consensus params (unknown KEYS like ignoreFields are already rejected by
    the closed-world key check on the consensus level; here we pin the VALUES)."""
    if c.get("maxParticipants") != 3:
        return f"maxParticipants={c.get('maxParticipants')!r} (must be int 3)", False
    if c.get("agreementThreshold") != 2:
        return f"agreementThreshold={c.get('agreementThreshold')!r} (must be int 2)", False
    # disputeBehavior: a DISPUTE means maxParticipants responded but fewer than
    # agreementThreshold agree. On OP's ~2s blocks publicnode + self routinely sit
    # 1 block apart on `latest`-tagged reads, so returnError failed ~30-50% of
    # quote/state reads (#476). `preferBlockHeadLeader` breaks that tie by freshest
    # block — it still requires the participants to have responded, so it is NOT a
    # 1-of-N bypass. Both are fail-closed-enough for DISPUTES; nothing else (e.g.
    # acceptMostCommonValidResult, onlyBlockHeadLeader) is permitted.
    if c.get("disputeBehavior") not in ("returnError", "preferBlockHeadLeader"):
        return (
            f"disputeBehavior={c.get('disputeBehavior')!r} "
            "(must be returnError or preferBlockHeadLeader)",
            False,
        )
    # lowParticipantsBehavior MUST stay returnError (Codex #476 P1). LOW
    # PARTICIPANTS means fewer than agreementThreshold upstreams returned a valid
    # response (an outage, not a disagreement); serving the lone freshest result
    # there downgrades 2-of-3 to 1-of-3, letting one hijacked/stale upstream supply
    # settlement state unchecked. Fail closed.
    if c.get("lowParticipantsBehavior") != "returnError":
        return f"lowParticipantsBehavior={c.get('lowParticipantsBehavior')!r} (must be returnError)", False
    return "", True


def _check_rule_subtree(r, path, errs, level="rule"):
    _check_keys(r, level, path, errs)
    if not _modellable(r.get("matchMethod")):
        errs.append(f"{path}: matchMethod {r.get('matchMethod')!r} has an un-modellable matcher char (only [A-Za-z0-9_*] + |)")
    if isinstance(r.get("timeout"), dict):
        _check_keys(r["timeout"], "timeout", f"{path}.timeout", errs)
    if isinstance(r.get("retry"), dict):
        _check_keys(r["retry"], "retry", f"{path}.retry", errs)
    if isinstance(r.get("hedge"), dict):
        _check_keys(r["hedge"], "hedge", f"{path}.hedge", errs)
    if isinstance(r.get("circuitBreaker"), dict):
        _check_keys(r["circuitBreaker"], "circuitBreaker", f"{path}.circuitBreaker", errs)
    if isinstance(r.get("consensus"), dict):
        _check_keys(r["consensus"], "consensus", f"{path}.consensus", errs)
        if isinstance(r["consensus"].get("punishMisbehavior"), dict):
            _check_keys(r["consensus"]["punishMisbehavior"], "punishMisbehavior", f"{path}.consensus.punishMisbehavior", errs)
        why, ok = _consensus_failclosed(r["consensus"])
        if not ok:
            errs.append(f"{path}.consensus is not fail-closed: {why}")


def _seconds(v):
    """Parse an eRPC duration ('12s', '200ms', '1.5s') to float seconds; None if unparseable."""
    m = re.fullmatch(r"\s*([0-9.]+)\s*(ms|s|m)\s*", str(v))
    if not m:
        return None
    n = float(m.group(1))
    return n / 1000 if m.group(2) == "ms" else n * 60 if m.group(2) == "m" else n


def _serial_budget_seconds(rule):
    """Worst-case time ONE upstream can hold a request under this rule:
    maxAttempts x timeout + a backoffMaxDelay-bounded gap between attempts."""
    t = _seconds(((rule.get("timeout") or {}).get("duration")))
    if t is None:
        return None
    retry = rule.get("retry") or {}
    attempts = int(retry.get("maxAttempts") or 1)
    gap = _seconds(retry.get("backoffMaxDelay") or retry.get("delay") or "0s") or 0.0
    return attempts * t + (attempts - 1) * gap


def _resolved_network_timeout(pattern_alt, net_rules):
    """The network timeout that ACTUALLY bounds requests for methods matching one
    upstream-rule alternative: build a representative concrete method from the
    alternative ('debug_*' -> 'debug_x'), then take the FIRST network rule that
    matches it, mirroring eRPC's first-match dispatch. Comparing pinned budgets
    against the largest timeout anywhere in the policy is a false-negative
    factory: a pinned eth_call rule with a 30s budget would pass while eth_call
    really lives under the 12s consensus rule."""
    rep = pattern_alt.replace("*", "x")
    for r in net_rules:
        if _method_matches(rep, r.get("matchMethod")):
            return _seconds((r.get("timeout") or {}).get("duration"))
    return None


def _check_upstream_budgets(ups, net_rules, errs):
    """THE 2026-08-14 INVARIANT: a single wedged upstream must never be able to
    exhaust the network-level failsafe budget before failover reaches a healthy
    lane. On 08-14 the routing-priority-1 lane became a silent blackhole and its
    8s x 3-attempt budget (~24.5s) ate the whole 12s network budget — every
    tip-following read died ErrFailsafeTimeoutExceeded with lastUpstream=nil for
    23 hours (3rd incident of this class: 07-23, 08-09, 08-14).

    Enforced: for every upstream rule that can serve arbitrary methods (matchMethod
    absent or containing a bare '*'), serial budget < the SMALLEST network-rule
    timeout. Method-pinned upstream rules (e.g. a debug_* rule on the only lane
    serving those methods) are checked per alternative against the network rule
    that actually dispatches that method — the tightest applicable deadline —
    and may at most EQUAL it (a sole-server lane has no failover to leave room
    for)."""
    net_timeouts = [_seconds((r.get("timeout") or {}).get("duration")) for r in net_rules]
    net_timeouts = [t for t in net_timeouts if t is not None]
    if not net_timeouts:
        errs.append("no network-rule timeouts found — cannot enforce the upstream serial-budget invariant")
        return
    strict_bound = min(net_timeouts)
    for u in ups:
        for j, r in enumerate(u.get("failsafe") or []):
            if not isinstance(r, dict):
                continue
            budget = _serial_budget_seconds(r)
            if budget is None:
                errs.append(f"upstream[{u.get('id')}].failsafe[{j}]: unparseable timeout — cannot verify the serial-budget invariant")
                continue
            mm = r.get("matchMethod")
            generic = mm is None or any(a.strip() == "*" for a in str(mm).split("|"))
            if generic:
                if budget >= strict_bound:
                    errs.append(
                        f"upstream[{u.get('id')}].failsafe[{j}]: worst-case serial budget {budget:.1f}s >= smallest "
                        f"network timeout {strict_bound:.1f}s — a single wedged lane can starve every request before "
                        f"failover (the 2026-08-14 outage); lower timeout/maxAttempts so attempts x timeout + backoff < {strict_bound:.1f}s"
                    )
                continue
            for alt in str(mm).split("|"):
                alt = alt.strip()
                if not alt:
                    continue
                bound = _resolved_network_timeout(alt, net_rules)
                if bound is None:
                    errs.append(
                        f"upstream[{u.get('id')}].failsafe[{j}]: no network rule dispatches methods matching {alt!r} — "
                        f"cannot verify its serial budget against a real deadline"
                    )
                elif budget > bound:
                    errs.append(
                        f"upstream[{u.get('id')}].failsafe[{j}]: serial budget {budget:.1f}s for {alt!r} exceeds the "
                        f"{bound:.1f}s network timeout of the rule that actually dispatches it — it can never complete "
                        f"within its real deadline"
                    )


def _check_nonconsensus_hedges(net_rules, errs):
    """The hedge is the mitigation PROVEN against a silently hanging lane (A/B on
    erpc 0.0.64: 12/12 x ~12s failures without it, 18/18 OK at ~1.1s with it) —
    the breaker alone cannot cover hangs because hedge-cancelled attempts may
    record no outcome. EVERY non-consensus rule routes sequentially and is
    exposed, so every one of them must hedge — checking only "a rule that
    matches eth_blockNumber" would let a method-specific rule inserted above the
    catch-all satisfy the guard while the real catch-all (still serving
    eth_getBlockByNumber and everything else) silently loses its hedge.
    Consensus rules are exempt: they fan out to all lanes in parallel and
    short-circuit on quorum. A bare-wildcard default rule must also EXIST, so no
    method falls off the end of the failsafe list."""
    if not any(r.get("matchMethod") is None or any(a.strip() == "*" for a in str(r.get("matchMethod")).split("|"))
               for r in net_rules):
        errs.append("no bare-wildcard catch-all network rule exists — methods outside the listed rules have no failsafe home")
    for i, r in enumerate(net_rules):
        if isinstance(r.get("consensus"), dict):
            continue
        path = f"network failsafe[{i}] ({r.get('matchMethod') or '*'!r})"
        hedge = r.get("hedge")
        if not isinstance(hedge, dict):
            errs.append(f"{path}: non-consensus rule has no hedge — a silently hanging priority-1 lane would starve these methods (2026-08-14)")
            continue
        d = _seconds(hedge.get("delay"))
        if d is None or d > 2.0:
            errs.append(f"{path}: hedge delay {hedge.get('delay')!r} must be a duration <= 2s to mask a hanging lane within block time")
        mc = hedge.get("maxCount")
        if not isinstance(mc, int) or isinstance(mc, bool) or mc < 1:
            errs.append(f"{path}: hedge maxCount {mc!r} must be an integer >= 1 — a zero/absent count certifies a hedge that never fires")


def validate(cfg):
    errs = []
    networks_checked = 0
    for proj in cfg.get("projects") or []:
        _check_keys(proj, "project", "project", errs)
        defaults = proj.get("upstreamDefaults") or {}
        if defaults:
            _check_keys(defaults, "upstreamDefaults", "project.upstreamDefaults", errs)
            if isinstance(defaults.get("evm"), dict):
                _check_keys(defaults["evm"], "upstreamDefaults.evm", "project.upstreamDefaults.evm", errs)
        ups = [u for u in (proj.get("upstreams") or []) if isinstance(u, dict)]
        for u in ups:
            _check_keys(u, "upstream", f"upstream[{u.get('id')}]", errs)
            for j, r in enumerate(u.get("failsafe") or []):
                if isinstance(r, dict):
                    _check_rule_subtree(r, f"upstream[{u.get('id')}].failsafe[{j}]", errs, level="upstream_rule")
        if len(ups) != EXPECTED_UPSTREAMS:
            errs.append(f"expected exactly {EXPECTED_UPSTREAMS} upstreams, found {len(ups)}: {[u.get('id') for u in ups]}")
        if len({u.get('id') for u in ups}) != len(ups):
            errs.append(f"upstream ids are not distinct: {[u.get('id') for u in ups]}")
        for u in ups:
            if not u.get("endpoint"):
                errs.append(f"upstream {u.get('id')!r} has no endpoint")
        hosts = {_hostname(u.get("endpoint")) for u in ups}
        if hosts != EXPECTED_UPSTREAM_HOSTS:
            errs.append(f"upstream hosts {sorted(hosts)} != the 3 expected independent failure domains {sorted(EXPECTED_UPSTREAM_HOSTS)} (sibling host / IP / extra provider dilutes 2-of-3-across-3; update EXPECTED_UPSTREAM_HOSTS only for a deliberate provider change)")
        for net in proj.get("networks") or []:
            if (net.get("evm") or {}).get("chainId") != CHAIN_ID:
                continue
            networks_checked += 1
            _check_keys(net, "network", f"network[{CHAIN_ID}]", errs)
            if isinstance(net.get("evm"), dict):
                _check_keys(net["evm"], "network.evm", f"network[{CHAIN_ID}].evm", errs)
                if isinstance(net["evm"].get("integrity"), dict):
                    _check_keys(net["evm"]["integrity"], "integrity", f"network[{CHAIN_ID}].evm.integrity", errs)
            rules = [r for r in (net.get("failsafe") or []) if isinstance(r, dict)]
            for i, r in enumerate(rules):
                _check_rule_subtree(r, f"network[{CHAIN_ID}].failsafe[{i}]", errs)
            _check_upstream_budgets(ups, rules, errs)
            _check_nonconsensus_hedges(rules, errs)
            # every protected method's FIRST matchMethod-matching rule must be a
            # fail-closed consensus rule (matchFinality is rejected by the schema
            # lock, so first-match is purely by method order).
            for m in PROTECTED_METHODS:
                first = next((r for r in rules if _method_matches(m, r.get("matchMethod"))), None)
                if first is None:
                    errs.append(f"{m}: no matching failsafe rule")
                elif not isinstance(first.get("consensus"), dict):
                    errs.append(f"{m}: first-matching failsafe rule has no consensus block (falls through to retry)")
                else:
                    why, ok = _consensus_failclosed(first["consensus"])
                    if not ok:
                        errs.append(f"{m}: first-matching consensus is not fail-closed: {why}")
    if networks_checked == 0:
        errs.append(f"no chain-{CHAIN_ID} network found")
    return list(dict.fromkeys(errs))


def main(path):
    try:
        with open(path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
    except Exception as e:  # noqa: BLE001 - any parse failure must fail closed
        print(f"ERROR (#447): cannot parse {path}: {e}", file=sys.stderr)
        return EXIT_FAIL
    errs = validate(cfg or {})
    if errs:
        print(f"ERROR (#447): Optimism eRPC config is not 2-of-3-across-3 fail-closed ({path}):", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return EXIT_FAIL
    print(
        "OK (#447): OP eRPC fail-closed — closed-world schema lock passed (no unrecognized config keys); "
        "exactly the 3 expected independent upstream hosts; every Block A+B method's first-matching failsafe "
        "rule is a maxParticipants:3/agreementThreshold:2 consensus block with lowParticipants:returnError "
        "(outage fail-closed) and dispute in {returnError, preferBlockHeadLeader} (#476); every consensus rule fail-closed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "configs/erpc.yaml.tmpl"))
