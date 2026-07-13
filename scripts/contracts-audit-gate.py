#!/usr/bin/env python3
"""Fail if contracts/ yarn audit regresses above the documented baseline."""
import json
import sys
from pathlib import Path

if len(sys.argv) != 3:
    print("usage: contracts-audit-gate.py <audit-jsonl> <baseline-json>", file=sys.stderr)
    sys.exit(2)

audit_path = Path(sys.argv[1])
baseline_path = Path(sys.argv[2])
baseline = json.loads(baseline_path.read_text())
counts = {"critical": 0, "high": 0, "moderate": 0, "low": 0}
seen = False

for line in audit_path.read_text().splitlines():
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except json.JSONDecodeError as exc:
        print(f"invalid yarn audit JSON line: {exc}", file=sys.stderr)
        sys.exit(1)
    if event.get("type") == "auditSummary":
        data = event.get("data") or {}
        vulns = data.get("vulnerabilities") or {}
        for severity in counts:
            counts[severity] = int(vulns.get(severity) or 0)
        seen = True

if not seen:
    print("yarn audit output did not contain an auditSummary event; failing closed", file=sys.stderr)
    sys.exit(1)

regressions = []
for severity, count in counts.items():
    allowed = int(baseline.get(severity, 0))
    if count > allowed:
        regressions.append(f"{severity}: {count} > baseline {allowed}")

print("contracts audit counts:", counts)
if regressions:
    print("contracts audit regression detected:")
    for item in regressions:
        print(f"  - {item}")
    sys.exit(1)

print("contracts audit is within the documented baseline")
