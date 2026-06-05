#!/usr/bin/env python3
"""Fail-closed guard for the Ophis Optimism eRPC config (#447).

Runs in CI against infra/optimism-mainnet/configs/erpc.yaml.tmpl. The rendered
config is byte-identical in consensus/upstream STRUCTURE — render-configs.sh's
envsubst only swaps `${VAR}` string values — so validating the template proves
the same invariants without parsing secrets.

Parses the YAML tree (never line greps) and proves the config keeps its
2-of-3-across-3 fail-closed consensus posture, modelling eRPC's runtime
semantics: `failsafe[]` is first-match top-to-bottom by `matchMethod` +
`matchFinality` (https://docs.erpc.cloud/config/failsafe). Exits non-zero on ANY
weakening so a PR that erodes consensus cannot merge.

WHY CI, NOT render-configs.sh: wiring PyYAML into the operator/DR render path
would make a stack restart fail on a host without PyYAML — worse than the
weakening it guards against (Codex #464 P1). Template edits go through PRs.

Rejects, for the chain-10 network:
  - upstreams != 3 with distinct ids AND distinct normalized hosts (a duplicated
    provider or a trailing-slash/query/:443/case alias of one node collapses the
    3 independent failure domains, letting one operator hold 2 of 3 votes);
  - any matchMethod / allowMethods / ignoreMethods using eRPC's `!` (NOT), `&`
    (AND) or `()` (grouping) operators — this guard only faithfully models `*`
    and `|`, so anything else is treated as UN-MODELLABLE and fails closed
    rather than being silently mis-classified (red-team: a `!eth_getLogs` rule
    before the consensus block is the real first-match in eRPC but invisible to
    a `|`/`*`-only matcher);
  - any upstream (incl. project-level `upstreamDefaults`) filtered from a
    critical method via allow/ignoreMethods (fewer than 3 eligible upstreams);
  - for any critical method x any finality, a FIRST-matching failsafe rule that
    is not a fail-closed consensus rule (catches an earlier `*`/retry rule, or a
    consensus rule scoped to only some finalities, leaving others uncovered);
  - a consensus block missing maxParticipants:3 / agreementThreshold:2 /
    dispute+lowParticipants:returnError, OR carrying `ignoreFields` (which lets a
    hostile upstream forge the skipped field while consensus still 'agrees').
"""
import fnmatch
import sys
from urllib.parse import urlsplit

import yaml

CHAIN_ID = 10
EXPECTED_UPSTREAMS = 3
CRITICAL_METHODS = ("eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt")
FINALITIES = ("finalized", "unfinalized", "realtime", "unknown")
# eRPC matchMethod operators this guard does NOT faithfully model. Any matcher
# string containing one is treated as un-modellable and fails closed.
UNMODELLABLE_OPERATORS = ("!", "&", "(", ")")
EXIT_FAIL = 14


def _modellable(pattern):
    return pattern is None or not any(op in str(pattern) for op in UNMODELLABLE_OPERATORS)


def _method_matches(method, pattern):
    """Match an eRPC matchMethod limited to the modellable subset (* glob, | OR).
    Only call on patterns that passed _modellable()."""
    if pattern is None:
        return True
    return any(
        alt.strip() and fnmatch.fnmatch(method, alt.strip())
        for alt in str(pattern).split("|")
    )


def _finality_matches(rule, finality):
    mf = rule.get("matchFinality")
    return not mf or finality in mf  # absent/empty = all finalities


def _norm_host(endpoint):
    """Normalized failure-domain key for an endpoint: lowercased host[:port],
    so trailing-slash / query / :443 / case aliases of one node collapse."""
    s = str(endpoint)
    try:
        u = urlsplit(s)
        if not u.hostname:
            return s.strip().rstrip("/").lower()  # e.g. an un-substituted ${VAR}
        port = u.port if u.port is not None else {"https": 443, "http": 80}.get((u.scheme or "").lower())
        return f"{u.hostname.lower()}:{port}"
    except Exception:
        return s


def _effective_serves(upstream, defaults, method):
    """Whether an upstream serves `method` after folding in project-level
    upstreamDefaults allow/ignoreMethods (inherited filters)."""
    for src in (defaults, upstream):
        allow = src.get("allowMethods")
        if allow and not any(_method_matches(method, p) for p in allow):
            return False
        ignore = src.get("ignoreMethods")
        if ignore and any(_method_matches(method, p) for p in ignore):
            return False
    return True


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
        ups = [u for u in (proj.get("upstreams") or []) if isinstance(u, dict)]
        if len(ups) != EXPECTED_UPSTREAMS:
            errs.append(f"expected exactly {EXPECTED_UPSTREAMS} upstreams, found {len(ups)}: {[u.get('id') for u in ups]}")
        ids = [u.get("id") for u in ups]
        if len(set(ids)) != len(ids):
            errs.append(f"upstream ids are not distinct: {ids}")
        hosts = [_norm_host(u.get("endpoint")) for u in ups]
        if len(set(hosts)) != len(hosts):
            errs.append(f"upstream endpoints collapse to fewer distinct hosts (same failure domain reused): {hosts}")
        # Un-modellable matcher operators anywhere in method filters -> fail closed.
        for label, src in [("upstreamDefaults", defaults)] + [(f"upstream {u.get('id')}", u) for u in ups]:
            for key in ("allowMethods", "ignoreMethods"):
                for p in src.get(key) or []:
                    if not _modellable(p):
                        errs.append(f"{label}.{key} pattern {p!r} uses an un-modellable eRPC operator (!/&/()) — refusing to certify")
        for net in proj.get("networks") or []:
            if (net.get("evm") or {}).get("chainId") != CHAIN_ID:
                continue
            networks_checked += 1
            rules = [r for r in (net.get("failsafe") or []) if isinstance(r, dict)]
            for r in rules:
                if not _modellable(r.get("matchMethod")):
                    errs.append(f"failsafe matchMethod {r.get('matchMethod')!r} uses an un-modellable eRPC operator (!/&/()) — refusing to certify (could be a hidden first-match)")
            for m in CRITICAL_METHODS:
                ineligible = [u.get("id") for u in ups if not _effective_serves(u, defaults, m)]
                if ineligible:
                    errs.append(f"{m}: filtered from upstream(s) (eligible < 3): {ineligible}")
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
    # de-dup while preserving order
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
        "OK (#447): OP eRPC fail-closed — 3 upstreams with distinct ids+hosts, none method-filtered; "
        "every critical method's first-matching failsafe rule across all finalities is a "
        "maxParticipants:3/agreementThreshold:2/returnError consensus block with no ignoreFields; "
        "no un-modellable matcher operators."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "configs/erpc.yaml.tmpl"))
