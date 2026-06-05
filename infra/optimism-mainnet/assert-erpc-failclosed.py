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
agreementThreshold:2, dispute+lowParticipants:returnError; every consensus rule
fail-closed; matchMethod uses only the modelled `*`/`|` matcher.
"""
import re
import sys
from urllib.parse import urlsplit

import yaml

CHAIN_ID = 10
EXPECTED_UPSTREAMS = 3
# The 3 intended INDEPENDENT failure domains (operator / DNS / network). Pinned by
# hostname so a sibling host, IP-literal, or extra provider cannot pose as a 3rd
# domain. A deliberate provider change (or the self node's IP rotating — see the
# template's "UPDATE THIS ENDPOINT" note) MUST update this set.
EXPECTED_UPSTREAM_HOSTS = frozenset({
    "optimism-rpc.publicnode.com",
    "optimism.gateway.tenderly.co",
    "100.77.53.81",
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
    "rule": {"matchMethod", "timeout", "consensus", "retry"},
    "consensus": {"agreementThreshold", "disputeBehavior", "lowParticipantsBehavior", "maxParticipants", "punishMisbehavior"},
    "punishMisbehavior": {"disputeThreshold", "disputeWindow", "sitOutPenalty"},
    "retry": {"backoffFactor", "backoffMaxDelay", "delay", "jitter", "maxAttempts"},
    "timeout": {"duration"},
    "upstream": {"endpoint", "failsafe", "id"},
    "upstream_rule": {"matchMethod", "timeout", "retry"},
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
    """consensus params (ignoreFields/prefer* are already rejected by the
    closed-world key check on the consensus level)."""
    if c.get("maxParticipants") != 3:
        return f"maxParticipants={c.get('maxParticipants')!r} (must be int 3)", False
    if c.get("agreementThreshold") != 2:
        return f"agreementThreshold={c.get('agreementThreshold')!r} (must be int 2)", False
    if c.get("disputeBehavior") != "returnError":
        return f"disputeBehavior={c.get('disputeBehavior')!r} (must be returnError)", False
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
    if isinstance(r.get("consensus"), dict):
        _check_keys(r["consensus"], "consensus", f"{path}.consensus", errs)
        if isinstance(r["consensus"].get("punishMisbehavior"), dict):
            _check_keys(r["consensus"]["punishMisbehavior"], "punishMisbehavior", f"{path}.consensus.punishMisbehavior", errs)
        why, ok = _consensus_failclosed(r["consensus"])
        if not ok:
            errs.append(f"{path}.consensus is not fail-closed: {why}")


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
        "rule is a maxParticipants:3/agreementThreshold:2/returnError consensus block; every consensus rule fail-closed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "configs/erpc.yaml.tmpl"))
