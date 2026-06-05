#!/usr/bin/env python3
"""Fail-closed guard for the Ophis Optimism eRPC config (#447).

Runs in CI against infra/optimism-mainnet/configs/erpc.yaml.tmpl. The rendered
config is byte-identical in consensus/upstream STRUCTURE (render-configs.sh's
envsubst only swaps `${VAR}` string values), so validating the template proves
the same invariants without parsing secrets.

Parses the YAML tree (never line greps) and proves the chain-10 config keeps its
2-of-3-across-3 fail-closed consensus posture, modelling eRPC routing semantics
(https://docs.erpc.cloud): `failsafe[]` is first-match top-to-bottom by
`matchMethod` + `matchFinality`; in matchMethod ONLY `*` is a wildcard (`?`, `[`,
`]` are literal — unlike Python fnmatch) with `|` alternation; method access is
filtered project -> network -> upstreamDefaults -> upstream with `allowMethods`
taking precedence over `ignoreMethods`; upstreams can be chain-pinned via
`evm.chainId`.

WHY CI, NOT render-configs.sh: wiring PyYAML into the operator/DR render path
would make a stack restart fail on a host without PyYAML — worse than the
weakening it guards against (Codex #464 P1). Template edits go through PRs.

Fails closed (exit 14) on ANY of, for the chain-10 network:
  - chain-10-eligible upstreams (evm.chainId in {unset,10}) whose hostnames are
    not EXACTLY the 3 expected independent failure domains (a sibling hostname,
    IP-literal, duplicate, or 4th provider collapses or dilutes the 2-of-3
    posture; intentional provider changes must update EXPECTED_UPSTREAM_HOSTS);
  - any matchMethod / allow / ignoreMethods segment with a char outside
    [A-Za-z0-9_*] (covers eRPC `!`/`&`/`()` AND fnmatch-only metachars `?`/`[`/`]`
    that the daemon treats as literal) — un-modellable, fails closed;
  - any protected method (Block A state-reads + Block B) excluded at project or
    network scope, or filtered from any upstream (eligible upstreams < 3);
  - any protected method whose FIRST-matching failsafe rule (per finality) is
    not a fail-closed consensus rule;
  - ANY consensus rule that is not fail-closed (catches a weakened Block B / any
    added block);
  where fail-closed consensus == maxParticipants:3, agreementThreshold:2,
  dispute+lowParticipants:returnError, and NO ignoreFields.
"""
import re
import sys
from urllib.parse import urlsplit

import yaml

CHAIN_ID = 10
EXPECTED_UPSTREAMS = 3
# The 3 intended INDEPENDENT failure domains (distinct operators / DNS / network).
# Pinned by hostname so a sibling hostname, IP-literal, or extra provider of the
# same operator cannot masquerade as a 3rd domain. Changing providers (or the
# self-hosted node's IP — see the template's "UPDATE THIS ENDPOINT" note) is a
# deliberate security decision that MUST update this set.
EXPECTED_UPSTREAM_HOSTS = frozenset({
    "optimism-rpc.publicnode.com",
    "optimism.gateway.tenderly.co",
    "100.77.53.81",
})
BLOCK_A = ("eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt")
BLOCK_B = ("eth_getLogs", "eth_getTransactionByHash", "eth_estimateGas", "eth_feeHistory", "eth_getTransactionCount")
PROTECTED_METHODS = BLOCK_A + BLOCK_B
FINALITIES = ("finalized", "unfinalized", "realtime", "unknown")
# eRPC matchMethod tokens we model: method-name chars, `*` wildcard. A `|`
# separates alternatives (handled before this check). Anything else (`!`, `&`,
# `(`, `)`, and fnmatch-only `?`/`[`/`]`) is rejected as un-modellable.
_SEGMENT_OK = re.compile(r"^[A-Za-z0-9_*]*$")
EXIT_FAIL = 14


def _modellable(pattern):
    if pattern is None:
        return True
    return all(_SEGMENT_OK.match(seg.strip()) for seg in str(pattern).split("|"))


def _method_matches(method, pattern):
    """Match a method against an eRPC matchMethod. ONLY `*` is a wildcard
    (everything else, incl. ?/[/], is literal); `|` is alternation. Call only on
    patterns that passed _modellable()."""
    if pattern is None:
        return True
    for alt in str(pattern).split("|"):
        alt = alt.strip()
        if not alt:
            continue
        rx = ".*".join(re.escape(part) for part in alt.split("*"))
        if re.fullmatch(rx, method):
            return True
    return False


def _finality_matches(rule, finality):
    mf = rule.get("matchFinality")
    return not mf or finality in mf  # absent/empty = all finalities


def _filter_serves(src, method):
    """eRPC: allowMethods (if set) takes precedence over ignoreMethods."""
    allow = src.get("allowMethods")
    if allow is not None:
        return any(_method_matches(method, p) for p in allow)
    ignore = src.get("ignoreMethods")
    if ignore and any(_method_matches(method, p) for p in ignore):
        return False
    return True


def _hostname(endpoint):
    s = str(endpoint)
    try:
        return (urlsplit(s).hostname or s.strip().rstrip("/")).lower()
    except Exception:
        return s.lower()


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
    prefer = sorted(k for k in c if str(k).startswith("prefer"))
    if prefer:
        return (
            f"quorum-overriding preference(s) {prefer} present (e.g. preferNonEmpty can return a "
            f"lone below-threshold result instead of returnError — defeats fail-closed)",
            False,
        )
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
        if len({u.get('id') for u in ups}) != len(ups):
            errs.append(f"upstream ids are not distinct: {[u.get('id') for u in ups]}")
        for u in ups:
            if not u.get("endpoint"):
                errs.append(f"upstream {u.get('id')!r} has no endpoint (a participant without an endpoint is not a usable consensus vote)")
        # Note (Codex #464 r6): upstreams here don't pin evm.chainId, so eRPC
        # auto-detects the chain from the endpoint. That is safe ONLY because the
        # host allowlist below forces every endpoint to be one of the 3 known OP
        # endpoints — a non-OP endpoint (which would auto-detect to another
        # chain) is rejected by the allowlist, and an upstream explicitly pinned
        # to a non-10 chain is dropped by _serves_chain above (failing the count).
        hosts = {_hostname(u.get("endpoint")) for u in ups}
        if hosts != EXPECTED_UPSTREAM_HOSTS:
            errs.append(f"chain-{CHAIN_ID} upstream hosts {sorted(hosts)} != the 3 expected independent failure domains {sorted(EXPECTED_UPSTREAM_HOSTS)} (a sibling host / IP-literal / extra provider dilutes the 2-of-3-across-3 posture; update EXPECTED_UPSTREAM_HOSTS only for a deliberate provider change)")
        for label, src in [("project", proj), ("upstreamDefaults", defaults)] + [(f"upstream {u.get('id')}", u) for u in all_ups]:
            for key in ("allowMethods", "ignoreMethods"):
                for p in src.get(key) or []:
                    if not _modellable(p):
                        errs.append(f"{label}.{key} pattern {p!r} has an un-modellable matcher char (only [A-Za-z0-9_*] + | allowed) — refusing to certify")
        for net in proj.get("networks") or []:
            if (net.get("evm") or {}).get("chainId") != CHAIN_ID:
                continue
            networks_checked += 1
            for key in ("allowMethods", "ignoreMethods"):
                for p in net.get(key) or []:
                    if not _modellable(p):
                        errs.append(f"network.{key} pattern {p!r} has an un-modellable matcher char — refusing to certify")
            rules = [r for r in (net.get("failsafe") or []) if isinstance(r, dict)]
            for r in rules:
                if not _modellable(r.get("matchMethod")):
                    errs.append(f"failsafe matchMethod {r.get('matchMethod')!r} has an un-modellable matcher char — refusing to certify (could be a hidden first-match)")
                if "consensus" in r:
                    why, ok = _failclosed_reason(r)
                    if not ok:
                        errs.append(f"consensus rule (matchMethod={r.get('matchMethod')!r}) is not fail-closed: {why}")
            for m in PROTECTED_METHODS:
                if not _filter_serves(proj, m):
                    errs.append(f"{m}: excluded by a project-level allow/ignoreMethods filter")
                if not _filter_serves(net, m):
                    errs.append(f"{m}: excluded by a network-level allow/ignoreMethods filter")
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
        "OK (#447): OP eRPC fail-closed — exactly the 3 expected independent upstream hosts; no project/"
        "network/upstream method filters excluding protected methods; every Block A+B method's "
        "first-matching failsafe rule across all finalities is a maxParticipants:3/agreementThreshold:2/"
        "returnError consensus block with no ignoreFields; every consensus rule fail-closed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "configs/erpc.yaml.tmpl"))
