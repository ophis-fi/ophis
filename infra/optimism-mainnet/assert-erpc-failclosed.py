#!/usr/bin/env python3
"""Fail-closed guard for the rendered eRPC config (#447).

Structurally validates (parses the YAML tree — not line greps, so comments,
key reordering, or added blocks cannot mask a weakening) that the rendered
Optimism eRPC config keeps its **2-of-3-across-3** fail-closed consensus shape.

Exits non-zero (render-configs.sh then refuses to render, so the stack won't
(re)boot) on ANY of:
  - not exactly 3 active upstreams. N>3 with maxParticipants:3 random sampling
    silently weakens the quorum to "any 2 of N"; N<3 collapses the
    failure-domain to 2-of-2 (Codex: "assert three upstreams still exist").
  - fewer than 2 consensus blocks on the chain-10 network.
  - ANY consensus block not {maxParticipants:3, agreementThreshold:2,
    disputeBehavior:returnError, lowParticipantsBehavior:returnError} — every
    block is checked, so adding a weakened block fails (Codex: "require
    returnError on every consensus block").
  - any settlement-authoritative state-read (eth_call, eth_getBalance,
    eth_getCode, eth_getStorageAt) no longer covered by a consensus
    matchMethod (Codex: "assert consensus still covers the critical methods").
"""
import sys

import yaml

EXPECTED_UPSTREAMS = 3
CHAIN_ID = 10
# Block-A settlement-authoritative state reads that MUST stay under consensus.
CRITICAL_METHODS = {"eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt"}
EXIT_FAIL = 14


def validate(cfg):
    errs = []
    networks_checked = 0
    for proj in cfg.get("projects") or []:
        ups = proj.get("upstreams") or []
        if len(ups) != EXPECTED_UPSTREAMS:
            ids = [u.get("id") for u in ups if isinstance(u, dict)]
            errs.append(
                f"expected exactly {EXPECTED_UPSTREAMS} upstreams, found {len(ups)}: {ids}"
            )
        for net in proj.get("networks") or []:
            if (net.get("evm") or {}).get("chainId") != CHAIN_ID:
                continue
            networks_checked += 1
            failsafe = net.get("failsafe") or []
            consensus_rules = [
                r for r in failsafe if isinstance(r, dict) and "consensus" in r
            ]
            if len(consensus_rules) < 2:
                errs.append(
                    f"chain {CHAIN_ID}: expected >=2 consensus blocks, found "
                    f"{len(consensus_rules)}"
                )
            covered = set()
            for rule in consensus_rules:
                c = rule.get("consensus") or {}
                match = rule.get("matchMethod", "") or ""
                tag = match[:40] or "<no matchMethod>"
                if c.get("maxParticipants") != 3:
                    errs.append(f"consensus[{tag}]: maxParticipants={c.get('maxParticipants')!r} (must be 3)")
                if c.get("agreementThreshold") != 2:
                    errs.append(f"consensus[{tag}]: agreementThreshold={c.get('agreementThreshold')!r} (must be 2)")
                if c.get("disputeBehavior") != "returnError":
                    errs.append(f"consensus[{tag}]: disputeBehavior={c.get('disputeBehavior')!r} (must be returnError)")
                if c.get("lowParticipantsBehavior") != "returnError":
                    errs.append(f"consensus[{tag}]: lowParticipantsBehavior={c.get('lowParticipantsBehavior')!r} (must be returnError)")
                covered |= {m.strip() for m in match.split("|") if m.strip()}
            missing = CRITICAL_METHODS - covered
            if missing:
                errs.append(
                    f"chain {CHAIN_ID}: critical state-read methods not under "
                    f"consensus: {sorted(missing)}"
                )
    if networks_checked == 0:
        errs.append(f"no chain-{CHAIN_ID} network found")
    return errs


def main(path):
    try:
        with open(path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
    except Exception as e:  # noqa: BLE001 - any parse failure must fail closed
        print(f"ERROR (#447): cannot parse {path}: {e}", file=sys.stderr)
        return EXIT_FAIL
    errs = validate(cfg or {})
    if errs:
        print(f"ERROR (#447): eRPC config is not 2-of-3-across-3 fail-closed ({path}):", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return EXIT_FAIL
    print(
        "  assert    eRPC fail-closed OK (3 upstreams; >=2 consensus blocks, each "
        "maxParticipants:3/agreementThreshold:2/returnError; eth_call+state-reads under consensus)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "rendered/erpc.yaml"))
