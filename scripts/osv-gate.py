#!/usr/bin/env python3
"""Shared CI audit gate over `osv-scanner --format json` output.

Background: npm retired the legacy audit endpoint
(https://registry.npmjs.org/-/npm/v1/security/audits -> HTTP 410), which broke
`pnpm audit` and `yarn audit`. osv-scanner reads pnpm-lock.yaml and yarn.lock
directly (full dev+prod tree) and resolves advisories against the GitHub/OSV
database, so the audit endpoint is no longer needed. This one gate replaces the
two duplicated inline-python heredocs in .github/workflows/security.yml AND the
old scripts/contracts-audit-gate.py.

Modes:
  advisories  Block HIGH/CRITICAL findings whose GHSA id is not in --ignore.
              (the two pnpm workspace jobs)
  baseline    Block if per-severity finding counts exceed a committed baseline
              JSON. (the legacy contracts toolchain, which carries a large known
              baseline and gates on regressions, not on absolute HIGH/CRITICAL)

Fail-closed by construction:
  - unreadable JSON or missing top-level 'results' key            -> exit 2
  - baseline mode without --baseline / unreadable baseline        -> exit 2
  - osv-scanner reported vulns (rc=1) but we parsed none          -> exit 2
    (schema drift guard; pass the scanner's exit code via --osv-rc)
The caller (CI) must ALSO guard the scanner's own exit code: only 0 (clean) and
1 (vulns found) may proceed to this gate; anything else (127 = bad path /
unparseable lockfile / osv.dev egress failure) must fail the step. Never `|| true`.
"""
import argparse
import collections
import json
import sys

SEVERITIES = ("critical", "high", "moderate", "low")


def ghsa_of(vuln):
    """The GHSA id for an OSV advisory. For npm-ecosystem advisories the primary
    `id` already IS the GHSA; fall back to the first GHSA alias so a future
    advisory keyed under a CVE/RUSTSEC id is still matchable by --ignore."""
    vid = vuln.get("id", "")
    if isinstance(vid, str) and vid.startswith("GHSA-"):
        return vid
    for alias in vuln.get("aliases") or []:
        if isinstance(alias, str) and alias.startswith("GHSA-"):
            return alias
    return vid or "?"


def iter_findings(doc):
    """Yield (name, version, ghsa, severity_lower, title) for every vulnerability."""
    for result in doc.get("results") or []:
        for pkg in result.get("packages") or []:
            p = pkg.get("package") or {}
            name = p.get("name", "?")
            version = p.get("version", "?")
            for vuln in pkg.get("vulnerabilities") or []:
                sev = ((vuln.get("database_specific") or {}).get("severity") or "").lower()
                title = vuln.get("summary") or vuln.get("id") or "?"
                yield name, version, ghsa_of(vuln), sev, title


def load_osv(path):
    try:
        with open(path) as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read osv JSON {path!r}: {exc} -- failing closed.", file=sys.stderr)
        sys.exit(2)
    if not isinstance(doc, dict) or "results" not in doc:
        print("ERROR: osv JSON has no top-level 'results' key -- failing closed.", file=sys.stderr)
        sys.exit(2)
    return doc


def mode_advisories(findings, ignore):
    blocking, ignored = [], []
    for name, version, ghsa, sev, title in findings:
        if sev not in ("high", "critical"):
            continue
        rec = f"{name}@{version} (sev={sev}, {ghsa}): {title}"
        (ignored if ghsa in ignore else blocking).append(rec)
    for entry in ignored:
        print(f"IGNORED (documented non-reachable): {entry}")
    if blocking:
        print(f"BLOCKING: {len(blocking)} HIGH/CRITICAL advisories")
        for entry in blocking:
            print(f"  - {entry}")
        sys.exit(1)
    print(f"OK -- none blocking ({len(ignored)} ignored)")


def mode_baseline(findings, baseline_path):
    try:
        baseline = json.loads(open(baseline_path).read())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read baseline {baseline_path!r}: {exc} -- failing closed.", file=sys.stderr)
        sys.exit(2)
    counts = collections.Counter(sev for _, _, _, sev, _ in findings if sev in SEVERITIES)
    regressions = []
    for sev in SEVERITIES:
        got = counts.get(sev, 0)
        allowed = int(baseline.get(sev, 0))
        status = "OK" if got <= allowed else "REGRESSION"
        print(f"  {sev}: {got} (baseline {allowed}) {status}")
        if got > allowed:
            regressions.append(f"{sev}: {got} > baseline {allowed}")
    if regressions:
        print("BLOCKING: audit counts regressed above documented baseline:")
        for entry in regressions:
            print(f"  - {entry}")
        sys.exit(1)
    print("OK -- no regression above baseline")


def main():
    ap = argparse.ArgumentParser(description="osv-scanner CI audit gate")
    ap.add_argument("osv_json", help="path to osv-scanner --format json output")
    ap.add_argument("--mode", choices=("advisories", "baseline"), required=True)
    ap.add_argument("--ignore", action="append", default=[], metavar="GHSA-ID",
                    help="advisories mode: GHSA id to allow-list (repeatable)")
    ap.add_argument("--baseline", help="baseline mode: path to per-severity baseline JSON")
    ap.add_argument("--osv-rc", type=int, default=None,
                    help="osv-scanner's exit code, for a fail-closed schema-drift check")
    args = ap.parse_args()

    doc = load_osv(args.osv_json)
    findings = list(iter_findings(doc))

    # Fail-closed schema-drift guard: if osv-scanner said it found vulnerabilities
    # (rc=1) but our parser extracted none, the JSON shape moved under us.
    if args.osv_rc == 1 and not findings:
        print("ERROR: osv-scanner reported vulnerabilities (rc=1) but the gate parsed "
              "none -- schema drift, failing closed.", file=sys.stderr)
        sys.exit(2)

    if args.mode == "advisories":
        mode_advisories(findings, set(args.ignore))
    else:
        if not args.baseline:
            print("ERROR: baseline mode requires --baseline -- failing closed.", file=sys.stderr)
            sys.exit(2)
        mode_baseline(findings, args.baseline)


if __name__ == "__main__":
    main()
