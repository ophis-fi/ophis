#!/usr/bin/env python3
"""Regression checks: security gates must reject new findings even at equal counts."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

GATE = Path(__file__).with_name('osv-gate.py')


def finding(advisory='GHSA-old', severity='HIGH'):
    return {'package': {'name': 'example', 'version': '1.0.0'},
            'vulnerabilities': [{'id': advisory, 'database_specific': {'severity': severity}}]}


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    report, baseline = root / 'report.json', root / 'baseline.json'
    baseline.write_text(json.dumps({'high': 1, 'findings': ['example@1.0.0 GHSA-old high']}))

    def check(document, expected, *flags):
        report.write_text(json.dumps(document))
        result = subprocess.run([sys.executable, str(GATE), str(report), *flags],
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == expected, (result.returncode, result.stdout, result.stderr)

    def document(*packages):
        return {'results': [{'packages': list(packages)}]}

    args = ('--mode', 'baseline', '--baseline', str(baseline), '--osv-rc', '1')
    check(document(finding()), 0, *args)
    check(document(finding('GHSA-new')), 1, *args)  # Same count, different advisory.
    check(document(finding(severity='CRITICAL')), 1, *args)
    check(document(finding(), finding('GHSA-new')), 1, *args)
    check(document(finding(severity='unknown')), 2, *args)
    mixed = finding('GHSA-reviewed-low', 'LOW')
    mixed['groups'] = [{'ids': ['GHSA-reviewed-low'], 'max_severity': '2.0'}]
    mixed['vulnerabilities'].append({'id': 'GHSA-unclassified'})
    check(document(mixed), 2, '--mode', 'advisories')
    cvss = finding(severity='unknown')
    cvss['groups'] = [{'ids': ['GHSA-old'], 'max_severity': '8.1'}]
    check(document(cvss), 1, '--mode', 'advisories')
    check(document(), 2, *args)  # Scanner found a vulnerability, parser found none.
    check({'results': None}, 2, *args)
    check({}, 2, *args)
    check({'results': []}, 0, '--mode', 'advisories', '--osv-rc', '0')
    check({'results': []}, 2, '--mode', 'advisories', '--osv-rc', '127')
    check(document(finding()), 1, '--mode', 'advisories', '--ignore', 'GHSA-old:2000-01-01')
    baseline.write_text(json.dumps({'high': 1}))  # Legacy count-only baseline fails closed.
    check(document(finding()), 2, *args)
print('osv gate: 14 regression checks passed')
