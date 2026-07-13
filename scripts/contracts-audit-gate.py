#!/usr/bin/env python3
"""Fail if contracts/ `yarn audit` regresses above the documented baseline.

WHY this keys on advisory IDENTITY, not just severity counts
------------------------------------------------------------
The first version of this gate consumed ONLY the aggregate `auditSummary`
severity counts (critical/high/moderate/low). That misses precisely the
regression the job exists to block: because it compares TOTALS, a brand-new
HIGH/CRITICAL advisory slips through whenever an OLD advisory at the same
severity disappears in the same PR (net count unchanged), or whenever the new
advisory still leaves the total at/under the frozen baseline. A count of
"233 high" says nothing about WHICH 233 — a swap is invisible to it.

So the gate now keys on advisory IDENTITY. `yarn audit --json` (yarn v1 /
lockfile v1 — contracts/ pins yarn@1.22.22) emits one `auditAdvisory` event
per (advisory, resolution-path) finding, each carrying the advisory's
`github_advisory_id` (GHSA), npm numeric `id`, `module_name`, `severity`, and
`resolution.path`. We collect the SET of HIGH/CRITICAL advisory identities
(<GHSA-or-npm-id>::<module>) and FAIL if any identity appears that is not in
the committed baseline set, while still allowing baselined ones. A swap
(advisory A vanishes, advisory B appears) now fails because B's identity is
net-new, even though the count stayed flat.

WHY identity = <id>::<module> and not the full resolution path: the advisory
id is the vulnerability's stable name across npm-advisory renumbering, and the
module disambiguates the same advisory hitting different packages. Keying on
the full dependency PATH would churn the baseline every time an unrelated dep
bump re-routes the SAME advisory through the tree, without adding security
signal (same advisory, same module = same vuln). A genuinely new advisory id —
or the same advisory reaching a NEW module — still blocks.

The severity COUNTS are retained as a SECONDARY guard (a coarse net that also
catches, e.g., a flood of new moderates/lows the identity set does not track),
and — importantly — as the ACTIVE protection during the migration window
before the identity set has been captured (see `identityBaselineGenerated`).

Baseline shape (schemaVersion 2):
    {
      "schemaVersion": 2,
      "identityBaselineGenerated": <bool>,   # false until `--generate` is run
      "acceptedHighCritical": { "<GHSA-or-npm-id>::<module>": {meta...}, ... },
      "counts": {"critical": N, "high": N, "moderate": N, "low": N},
      "notes": [...]
    }

USAGE
    # CI (default): compare the audit JSONL against the committed baseline.
    scripts/contracts-audit-gate.py <audit-jsonl> <baseline-json>

    # Regenerate the baseline after triaging/ack'ing the current advisories.
    # Must run on a machine that can `yarn install && yarn audit --json` for
    # contracts/ (the advisory DB needs network); commit the result.
    scripts/contracts-audit-gate.py --generate <audit-jsonl> <baseline-json>

Fail-closed: a malformed JSONL line, a missing `auditSummary`, a summary that
reports high/critical while zero identities were parsed (auditAdvisory shape
changed under us), or a high/critical advisory we cannot assign an identity
to, all FAIL the gate rather than pass on ambiguous input.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SEVERITIES = ("critical", "high", "moderate", "low")
# Only HIGH/CRITICAL get per-advisory identity tracking; moderate/low remain
# on the coarse count guard (they are noisy in a legacy toolchain and are not
# what this gate is meant to hard-block).
BLOCKING_SEVERITIES = ("critical", "high")


def _advisory_identity(advisory: dict) -> str | None:
    """Stable identity for one advisory: `<GHSA-or-npm-id>::<module>`.

    Prefer the GHSA id (stable across npm-advisory-id renumbering), fall back
    to the npm numeric id. Returns None if neither an id nor a module can be
    derived — the caller fails closed on that, because an unclassifiable
    high/critical advisory must never be silently dropped from the set.
    """
    ghsa = (advisory.get("github_advisory_id") or "").strip()
    npm_id = advisory.get("id")
    module = (advisory.get("module_name") or "").strip()
    ident_id = ghsa or (f"npm:{npm_id}" if npm_id not in (None, "") else "")
    if not ident_id and not module:
        return None
    return f"{ident_id or 'unknown-id'}::{module or 'unknown-module'}"


def parse_audit(audit_path: Path) -> tuple[dict, dict, bool]:
    """Return (counts, high_critical, saw_summary).

    counts        {severity: int} from the auditSummary event.
    high_critical {identity: meta} for HIGH/CRITICAL auditAdvisory events,
                  where meta records severity/id/module/title and the number
                  of resolution paths the identity was seen on.
    Fails closed (exit 1) on malformed JSON or an unclassifiable
    high/critical advisory.
    """
    counts = {s: 0 for s in SEVERITIES}
    high_critical: dict[str, dict] = {}
    saw_summary = False

    for line in audit_path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"invalid yarn audit JSON line: {exc}", file=sys.stderr)
            sys.exit(1)

        etype = event.get("type")
        if etype == "auditSummary":
            data = event.get("data") or {}
            vulns = data.get("vulnerabilities") or {}
            for severity in counts:
                counts[severity] = int(vulns.get(severity) or 0)
            saw_summary = True
        elif etype == "auditAdvisory":
            data = event.get("data") or {}
            advisory = data.get("advisory") or {}
            severity = advisory.get("severity")
            if severity not in BLOCKING_SEVERITIES:
                continue
            identity = _advisory_identity(advisory)
            if identity is None:
                # A high/critical finding we cannot even name must not slip
                # through — fail closed rather than under-count the set.
                print(
                    "yarn audit emitted a high/critical advisory with no "
                    f"derivable id or module: {json.dumps(advisory)[:300]}; "
                    "failing closed",
                    file=sys.stderr,
                )
                sys.exit(1)
            entry = high_critical.setdefault(
                identity,
                {
                    "severity": severity,
                    "id": identity.split("::", 1)[0],
                    "module": advisory.get("module_name") or "",
                    "title": advisory.get("title") or "",
                    "paths": 0,
                },
            )
            entry["paths"] += 1
            # Critical dominates if the same identity is reported at both.
            if severity == "critical":
                entry["severity"] = "critical"

    return counts, high_critical, saw_summary


def cmd_generate(audit_path: Path, baseline_path: Path) -> int:
    counts, high_critical, saw_summary = parse_audit(audit_path)
    if not saw_summary:
        print(
            "yarn audit output did not contain an auditSummary event; "
            "refusing to generate a baseline from it",
            file=sys.stderr,
        )
        return 1
    payload = {
        "schemaVersion": 2,
        "identityBaselineGenerated": True,
        "acceptedHighCritical": dict(sorted(high_critical.items())),
        "counts": counts,
        "notes": [
            "acceptedHighCritical is the SET of accepted HIGH/CRITICAL "
            "advisory identities (<GHSA-or-npm-id>::<module>) for contracts/ "
            "as of the last `--generate` run.",
            "counts is the per-severity resolution-path count from the same "
            "auditSummary, kept as a secondary regression guard.",
            "contracts/ is a legacy deployment/test toolchain; this gate "
            "prevents regressions while modernization removes the baseline.",
            "Regenerate after triaging new advisories: "
            "scripts/contracts-audit-gate.py --generate <audit-jsonl> "
            "audit/contracts-yarn-audit-baseline.json",
        ],
    }
    baseline_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(
        f"Wrote {baseline_path}: {len(high_critical)} accepted high/critical "
        f"identities, counts={counts}"
    )
    return 0


def cmd_check(audit_path: Path, baseline_path: Path) -> int:
    try:
        baseline = json.loads(baseline_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(
            f"cannot read baseline {baseline_path}: {exc}; failing closed",
            file=sys.stderr,
        )
        return 1
    if not isinstance(baseline, dict):
        print("baseline is not a JSON object; failing closed", file=sys.stderr)
        return 1

    counts, high_critical, saw_summary = parse_audit(audit_path)
    if not saw_summary:
        print(
            "yarn audit output did not contain an auditSummary event; failing closed",
            file=sys.stderr,
        )
        return 1

    # Cross-check the two views agree the audit produced parseable data: if the
    # summary reports high/critical findings but we matched ZERO identities,
    # the auditAdvisory shape changed under us -> fail closed rather than pass
    # on a silently-empty identity set (same principle as the pnpm-audit
    # metadata cross-check in security.yml).
    summary_hc = counts["critical"] + counts["high"]
    if summary_hc > 0 and not high_critical:
        print(
            f"auditSummary reports {summary_hc} high/critical but zero "
            "auditAdvisory identities parsed (shape mismatch?); failing closed",
            file=sys.stderr,
        )
        return 1

    regressions: list[str] = []

    # -- Secondary guard: severity COUNTS vs baseline counts. Coarse net; also
    #    the ACTIVE protection until the identity set has been generated. --
    baseline_counts = baseline.get("counts")
    if not isinstance(baseline_counts, dict):
        # Back-compat with the schemaVersion-1 file, which stored the counts
        # at the top level.
        baseline_counts = baseline
    for severity in SEVERITIES:
        allowed = int(baseline_counts.get(severity, 0) or 0)
        if counts[severity] > allowed:
            regressions.append(
                f"count {severity}: {counts[severity]} > baseline {allowed}"
            )

    # -- Primary guard: advisory IDENTITY set. Any HIGH/CRITICAL identity not
    #    in the accepted baseline set is a net-new advisory -> block, even if
    #    the counts stayed flat (the swap the count guard cannot see). --
    accepted = baseline.get("acceptedHighCritical")
    identity_gate_active = bool(baseline.get("identityBaselineGenerated")) and isinstance(
        accepted, dict
    )
    if identity_gate_active:
        accepted_ids = set(accepted.keys())
        new_ids = set(high_critical.keys()) - accepted_ids
        for ident in sorted(new_ids):
            meta = high_critical[ident]
            regressions.append(
                f"NEW {meta['severity']} advisory {ident} ({meta.get('title', '?')})"
            )
    else:
        # Migration window: the identity set has not been captured yet (needs a
        # runner with network access to the advisory DB via `--generate`). Do
        # NOT fail solely for this — that would turn CI red on a green tree —
        # but warn LOUDLY so the stronger gate gets activated. The counts guard
        # above stays fully enforced meanwhile, so no protection is weakened
        # relative to the previous counts-only gate.
        print(
            "WARNING: identity baseline not generated "
            "(identityBaselineGenerated=false / acceptedHighCritical missing). "
            "The advisory-IDENTITY gate is INACTIVE; only the coarse severity-"
            "count guard is enforced. Run `scripts/contracts-audit-gate.py "
            "--generate <audit-jsonl> audit/contracts-yarn-audit-baseline.json` "
            "on a networked runner and commit the result to activate net-new-"
            "advisory blocking.",
            file=sys.stderr,
        )

    print(f"contracts audit counts: {counts}")
    print(
        f"high/critical identities: {len(high_critical)} "
        f"(identity gate {'ACTIVE' if identity_gate_active else 'INACTIVE'})"
    )
    if regressions:
        print("contracts audit regression detected:")
        for item in regressions:
            print(f"  - {item}")
        return 1

    print("contracts audit is within the documented baseline")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="contracts/ yarn-audit regression gate (identity + counts)"
    )
    parser.add_argument(
        "--generate",
        action="store_true",
        help="Regenerate the baseline (identity set + counts) from the audit "
        "JSONL, then exit.",
    )
    parser.add_argument(
        "audit_jsonl", type=Path, help="yarn audit --json output (JSONL)"
    )
    parser.add_argument(
        "baseline_json", type=Path, help="committed baseline file"
    )
    args = parser.parse_args()

    if args.generate:
        return cmd_generate(args.audit_jsonl, args.baseline_json)
    return cmd_check(args.audit_jsonl, args.baseline_json)


if __name__ == "__main__":
    raise SystemExit(main())
