#!/usr/bin/env python3
"""Fail-closed guard for the Ophis Optimism eRPC config (#447).

Runs in CI against infra/optimism-mainnet/configs/erpc.yaml.tmpl. The rendered
config is byte-identical in consensus/upstream STRUCTURE (render-configs.sh's
envsubst only swaps `${VAR}` string values), so validating the template proves
the same invariants without parsing secrets.

Parses the YAML tree (never line greps) and proves the chain-10 config keeps its
2-of-3-across-3 fail-closed consensus posture, modelling eRPC routing semantics
(https://docs.erpc.cloud): `failsafe[]` is first-match top-to-bottom by
`matchMethod` + `matchFinality`; method access is filtered at project ->
network -> upstreamDefaults -> upstream scope with `allowMethods` taking
precedence over `ignoreMethods`; upstreams can be pinned to a chain via
`evm.chainId`.

WHY CI, NOT render-configs.sh: wiring PyYAML into the operator/DR render path
would make a stack restart fail on a host without PyYAML — worse than the
weakening it guards against (Codex #464 P1). Template edits go through PRs.

Fails closed (exit 14) on ANY of, for the chain-10 network:
  - chain-10-eligible upstreams (evm.chainId in {unset,10}) != 3 with distinct
    ids AND distinct normalized hosts (a duplicated provider or a
    trailing-slash/query/:443/case alias collapses the 3 failure domains; an
    upstream pinned to another chain does not serve OP and must not be counted);
  - any matchMethod / allow / ignoreMethods using eRPC `!` (NOT), `&` (AND) or
    `()` operators — only `*` and `|` are modelled, the rest fail closed;
  - any protected method (Block A state-reads + Block B) excluded at project or
    network scope, or filtered from any upstream (eligible upstreams < 3);
  - any protected method whose FIRST-matching failsafe rule (per finality) is
    not a fail-closed consensus rule;
  - ANY consensus rule in the failsafe that is not fail-closed (so a weakening
    to Block B, or any added block, is caught directly);
  where fail-closed consensus == maxParticipants:3, agreementThreshold:2,
  dispute+lowParticipants:returnError, and NO ignoreFields.
"""
import fnmatch
import sys
from urllib.parse import urlsplit

import yaml

CHAIN_ID = 10
EXPECTED_UPSTREAMS = 3
# Methods the template places under fail-closed consensus — mirror the two
# consensus blocks in configs/erpc.yaml.tmpl. Each must keep a fail-closed
# consensus first-match. (Changing this set is a deliberate, reviewed edit.)
BLOCK_A = ("eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt")
BLOCK_B = ("eth_getLogs", "eth_getTransactionByHash", "eth_estimateGas", "eth_feeHistory", "eth_getTransactionCount")
PROTECTED_METHODS = BLOCK_A + BLOCK_B
FINALITIES = ("finalized", "unfinalized", "realtime", "unknown")
UNMODELLABLE_OPERATORS = ("!", "&", "(", ")")
EXIT_FAIL = 14


def _modellable(pattern):
    return pattern is None or not any(op in str(pattern) for op in UNMODELLABLE_OPERATORS)


def _method_matches(method, pattern):
    """Match an eRPC matchMethod limited to the modellable subset (* glob, | OR)."""
    if pattern is None:
        return True
    return any(
        alt.strip() and fnmatch.fnmatch(method, alt.strip())
        for alt in str(pattern).split("|")
    )


def _finality_matches(rule, finality):
    mf = rule.get("matchFinality")
    return not mf or finality in mf  # absent/empty = all finalities


def _filter_serves(src, method):
    """Whether a filter scope (project/network/upstream) serves `method`.
    eRPC: allowMethods takes precedence over ignoreMethods — if allowMethods is
    set, only matching methods are served and ignoreMethods is irrelevant."""
    allow = src.get("allowMethods")
    if allow is not None:
        return any(_method_matches(method, p) for p in allow)
    ignore = src.get("ignoreMethods")
    if ignore and any(_method_matches(method, p) for p in ignore):
        return False
    return True


def _norm_host(endpoint):
    """Normalized failure-domain key (lowercased host:port) so trailing-slash /
    query / :443 / case aliases of one node collapse to the same key."""
    s = str(endpoint)
    try:
        u = urlsplit(s)
        if not u.hostname:
            return s.strip().rstrip("/").lower()  # e.g. an un-substituted ${VAR}
        port = u.port if u.port is not None else {"https": 443, "http": 80}.get((u.scheme or "").lower())
        return f"{u.hostname.lower()}:{port}"
    except Exception:
        return s


def _serves_chain(upstream):
    cid = (upstream.get("evm") or {}).get("chainId")
    return cid is None or cid == CHAIN_ID


def _failclosed_reason(rule):
    c = rule.get("consensus")
    if not isinstance(c, dict):
        return "first-match rule is not a consensus rule (falls through to retry/no-consensus)", False
    if c.get("maxParticipants") != 3:
        return f"maxParticipants={c.get('maxParticipants')!r} (must be int 3)", False
    if c.get("agreementThreshold") != 2:
        return f"agreementThreshold={c.get('agreementThreshold')!r} (must be int 2)", False
    if c.get("disputeBehavior") != "returnError":
        return f"disputeBehavior={c.get('disputeBehavior')!r} (must be returnError)", False
    if c.get("lowParticipantsBehavior") != "returnError":
        return f"lowParticipantsBehavior={c.get('lowParticipantsBehavior')!r} (must be returnError)", False
    if c.get("ignoreFields"):
        return f"ignoreFields={c.get('ignoreFields')!r} (must be absent — lets an upstream forge the skipped field)", False
    return "", True


def validate(cfg):
    errs = []
    networks_checked = 0
    for proj in cfg.get("projects") or []:
        defaults = proj.get("upstreamDefaults") or {}
        all_ups = [u for u in (proj.get("upstreams") or []) if isinstance(u, dict)]
        ups = [u for u in all_ups if _serves_chain(u)]  # chain-10-eligible only
        if len(ups) != EXPECTED_UPSTREAMS:
            errs.append(f"expected exactly {EXPECTED_UPSTREAMS} chain-{CHAIN_ID} upstreams, found {len(ups)} (of {len(all_ups)} total): {[u.get('id') for u in ups]}")
        ids = [u.get("id") for u in ups]
        if len(set(ids)) != len(ids):
            errs.append(f"upstream ids are not distinct: {ids}")
        hosts = [_norm_host(u.get("endpoint")) for u in ups]
        if len(set(hosts)) != len(hosts):
            errs.append(f"upstream endpoints collapse to fewer distinct hosts (same failure domain reused): {hosts}")
        # Un-modellable matcher operators anywhere in method filters -> fail closed.
        for label, src in [("project", proj), ("upstreamDefaults", defaults)] + [(f"upstream {u.get('id')}", u) for u in all_ups]:
            for key in ("allowMethods", "ignoreMethods"):
                for p in src.get(key) or []:
                    if not _modellable(p):
                        errs.append(f"{label}.{key} pattern {p!r} uses an un-modellable eRPC operator (!/&/()) — refusing to certify")
        for net in proj.get("networks") or []:
            if (net.get("evm") or {}).get("chainId") != CHAIN_ID:
                continue
            networks_checked += 1
            for key in ("allowMethods", "ignoreMethods"):
                for p in net.get(key) or []:
                    if not _modellable(p):
                        errs.append(f"network.{key} pattern {p!r} uses an un-modellable eRPC operator (!/&/()) — refusing to certify")
            rules = [r for r in (net.get("failsafe") or []) if isinstance(r, dict)]
            for r in rules:
                if not _modellable(r.get("matchMethod")):
                    errs.append(f"failsafe matchMethod {r.get('matchMethod')!r} uses an un-modellable eRPC operator (!/&/()) — refusing to certify (could be a hidden first-match)")
            # Every consensus rule must itself be fail-closed (catches a weakened
            # Block B / any added block even if its methods are matched elsewhere).
            for r in rules:
                if "consensus" in r:
                    why, ok = _failclosed_reason(r)
                    if not ok:
                        errs.append(f"consensus rule (matchMethod={r.get('matchMethod')!r}) is not fail-closed: {why}")
            for m in PROTECTED_METHODS:
                # project/network-scope exclusion = method rejected before upstreams.
                if not _filter_serves(proj, m):
                    errs.append(f"{m}: excluded by a project-level allow/ignoreMethods filter")
                if not _filter_serves(net, m):
                    errs.append(f"{m}: excluded by a network-level allow/ignoreMethods filter")
                # per-upstream eligibility (upstream filter overrides defaults).
                ineligible = []
                for u in ups:
                    eff = {
                        "allowMethods": u.get("allowMethods", defaults.get("allowMethods")),
                        "ignoreMethods": u.get("ignoreMethods", defaults.get("ignoreMethods")),
                    }
                    if not _filter_serves(eff, m):
                        ineligible.append(u.get("id"))
                if ineligible:
                    errs.append(f"{m}: filtered from upstream(s) (eligible < 3): {ineligible}")
                # first-matching failsafe rule per finality must be fail-closed consensus.
                bad = []
                for fin in FINALITIES:
                    first = next(
                        (r for r in rules if _method_matches(m, r.get("matchMethod")) and _finality_matches(r, fin)),
                        None,
                    )
                    if first is None:
                        bad.append(f"{fin}: no matching failsafe rule")
                        continue
                    why, ok = _failclosed_reason(first)
                    if not ok:
                        bad.append(f"{fin}: {why}")
                if bad:
                    errs.append(f"{m}: first-matching failsafe rule is not fail-closed consensus -> " + "; ".join(bad))
    if networks_checked == 0:
        errs.append(f"no chain-{CHAIN_ID} network found")
    return list(dict.fromkeys(errs))  # de-dup, preserve order


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
        "OK (#447): OP eRPC fail-closed — 3 chain-10 upstreams with distinct ids+hosts, no project/"
        "network/upstream method filters excluding protected methods; every Block A+B method's "
        "first-matching failsafe rule across all finalities is a maxParticipants:3/agreementThreshold:2/"
        "returnError consensus block with no ignoreFields; and every consensus rule is fail-closed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "configs/erpc.yaml.tmpl"))
