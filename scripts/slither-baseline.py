#!/usr/bin/env python3
"""Slither baseline fingerprinting + diff.

Generates and verifies a stable fingerprint baseline of Slither findings.
Used by CI to gate net-new findings without false positives from
line-shift code reorgs.

Fingerprint = sha256(check | impact | file_basename | contract | function)[:16]

USAGE

    # Generate a baseline (run after auditing + ack'ing all current findings)
    python3 scripts/slither-baseline.py \
        --generate audit/slither-baseline.json \
        /path/to/settlement.json /path/to/auth.json

    # CI: compare current findings against baseline
    python3 scripts/slither-baseline.py \
        --check audit/slither-baseline.json \
        /tmp/settlement.json /tmp/auth.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path


def _extract_location(finding: dict) -> tuple[str, str, str]:
    """Pull (file_basename, contract_name, function_name) from elements."""
    file_basename = ""
    contract_name = ""
    function_name = ""
    for el in finding.get("elements", []):
        sm = el.get("source_mapping") or {}
        rel = sm.get("filename_relative") or ""
        if rel and not file_basename:
            file_basename = rel.split("/")[-1]
        if el.get("type") == "contract" and not contract_name:
            contract_name = el.get("name", "") or ""
        if el.get("type") == "function" and not function_name:
            function_name = el.get("name", "") or ""
    return file_basename, contract_name, function_name


def fingerprint(finding: dict) -> str:
    file_basename, contract_name, function_name = _extract_location(finding)
    parts = (
        finding.get("check", ""),
        finding.get("impact", ""),
        file_basename,
        contract_name,
        function_name,
    )
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return digest[:16]


def collect_findings(paths: list[Path]) -> dict[str, dict]:
    """Load slither JSONs and return {fingerprint: {meta...}} deduped."""
    findings: dict[str, dict] = {}
    for p in paths:
        if not p.exists():
            print(f"WARN: {p} missing — skipped", file=sys.stderr)
            continue
        with p.open() as f:
            data = json.load(f)
        for raw in data.get("results", {}).get("detectors", []):
            fp = fingerprint(raw)
            if fp in findings:
                continue
            file_b, contract, func = _extract_location(raw)
            findings[fp] = {
                "check": raw.get("check"),
                "impact": raw.get("impact"),
                "file": file_b,
                "contract": contract,
                "function": func,
                "description": (raw.get("description") or "").splitlines()[0][:200],
            }
    return findings


def cmd_generate(out: Path, slither_jsons: list[Path]) -> int:
    findings = collect_findings(slither_jsons)
    by_impact = Counter(f["impact"] for f in findings.values())
    payload = {
        "schema_version": 1,
        "summary": {
            "total": len(findings),
            "by_impact": dict(by_impact),
        },
        "findings": findings,
    }
    out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {out} with {len(findings)} unique fingerprints")
    print(f"By impact: {dict(by_impact)}")
    return 0


def cmd_check(baseline_path: Path, slither_jsons: list[Path]) -> int:
    if not baseline_path.exists():
        print(f"FAIL: baseline {baseline_path} missing", file=sys.stderr)
        return 2
    with baseline_path.open() as f:
        baseline = json.load(f)
    baseline_fps = set(baseline.get("findings", {}).keys())

    current = collect_findings(slither_jsons)
    current_fps = set(current.keys())

    new_fps = current_fps - baseline_fps
    removed_fps = baseline_fps - current_fps

    print(f"Baseline: {len(baseline_fps)} fingerprints")
    print(f"Current:  {len(current_fps)} fingerprints")
    print(f"New:      {len(new_fps)}")
    print(f"Removed:  {len(removed_fps)}")

    if removed_fps:
        print()
        print("Removed (informational — baseline can be regenerated):")
        for fp in sorted(removed_fps):
            meta = baseline["findings"][fp]
            print(
                f"  - [{fp}] [{meta['impact']}] {meta['check']} :: "
                f"{meta['file']} :: {meta['contract']}.{meta['function']}"
            )

    if new_fps:
        print()
        print("NET-NEW findings (must be triaged):")
        for fp in sorted(new_fps):
            meta = current[fp]
            print(
                f"  - [{fp}] [{meta['impact']}] {meta['check']} :: "
                f"{meta['file']} :: {meta['contract']}.{meta['function']}"
            )
            if meta.get("description"):
                print(f"      {meta['description']}")
        print()
        print("Triage options:")
        print("  1. Fix the underlying issue + rerun this check")
        print("  2. If false-positive or acknowledged, regenerate baseline:")
        print(
            "       python3 scripts/slither-baseline.py "
            "--generate audit/slither-baseline.json <slither-jsons...>"
        )
        return 1

    print()
    print("OK -- no net-new findings vs baseline.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--generate", type=Path, help="Write baseline to this path")
    mode.add_argument("--check", type=Path, help="Verify findings against this baseline")
    parser.add_argument(
        "slither_jsons",
        nargs="+",
        type=Path,
        help="One or more slither --json output files",
    )
    args = parser.parse_args()

    if args.generate:
        return cmd_generate(args.generate, args.slither_jsons)
    return cmd_check(args.check, args.slither_jsons)


if __name__ == "__main__":
    raise SystemExit(main())
