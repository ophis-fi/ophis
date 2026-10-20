#!/usr/bin/env python3
"""The compatibility correction must never admit an unpatched/unknown payload."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest

from webpki_compat import ADVISORY, CHECKSUMS, SOURCE, deny_config, verified_shim


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.lock = Path(self.directory.name) / "Cargo.lock"
        self.roots = [
            {"name": "webpki-roots", "version": version, "source": SOURCE, "checksum": checksum,
             "dependencies": ["webpki-roots 1.0.10"] if version == "0.26.11" else ["rustls-pki-types"]}
            for version, checksum in CHECKSUMS.items()
        ]
        self.write_lock(self.roots)

    def write_lock(self, packages):
        self.lock.write_text("\n".join("[[package]]\n" + "\n".join(
            f"{key} = {json.dumps(value)}" for key, value in package.items()) for package in packages))

    def test_reviewed_graph(self):
        self.assertTrue(verified_shim(self.lock))

    def test_unknown_or_unpatched_graphs_fail(self):
        for index, field, value in [
            (0, "source", "git+https://example.invalid/replacement"),
            (0, "checksum", "0" * 64), (1, "checksum", "0" * 64),
            (0, "dependencies", ["webpki-roots 1.0.9"]),
            (1, "version", "1.0.9"), (1, "version", "1.0.11"),
            (1, "dependencies", ["unknown-payload"]),
        ]:
            with self.subTest(index=index, field=field, value=value):
                packages = copy.deepcopy(self.roots)
                packages[index][field] = value
                self.write_lock(packages)
                with self.assertRaises(ValueError):
                    verified_shim(self.lock)
        for packages in [self.roots[:1], self.roots + [self.roots[1]]]:
            self.write_lock(packages)
            with self.assertRaises(ValueError):
                verified_shim(self.lock)

    def test_no_shim_leaves_normal_gates_in_charge(self):
        self.write_lock([self.roots[1]])
        self.assertFalse(verified_shim(self.lock))

    def test_deny_correction_preserves_all_other_policy(self):
        config = Path(self.directory.name) / "deny.toml"
        config.write_text('[advisories]\nignore = ["RUSTSEC-existing"]\n[sources]\nunknown-git = "deny"\n')
        before = tomllib.loads(config.read_text())
        before["advisories"]["ignore"].insert(0, ADVISORY)
        self.assertEqual(tomllib.loads(deny_config(self.lock, config)), before)
        self.write_lock([self.roots[1]])
        self.assertEqual(deny_config(self.lock, config), config.read_text())

    def test_osv_removes_only_the_exact_verified_finding(self):
        report = Path(self.directory.name) / "report.json"
        def gate(advisories, ecosystem="crates.io"):
            report.write_text(json.dumps({"results": [{"packages": [{
                "package": {"name": "webpki-roots", "version": "0.26.11", "ecosystem": ecosystem},
                "vulnerabilities": [{"id": advisory, "database_specific": {"severity": "HIGH"}}
                                    for advisory in advisories]}]}]}))
            return subprocess.run([sys.executable, str(Path(__file__).with_name("osv-gate.py")),
                                   str(report), "--mode", "advisories", "--osv-rc", "1",
                                   "--cargo-lock", str(self.lock)], capture_output=True).returncode
        self.assertEqual(gate([ADVISORY]), 0)
        self.assertEqual(gate([ADVISORY, "RUSTSEC-2026-0382"]), 1)
        self.assertEqual(gate(["CVE-2026-111943"]), 1)
        self.assertEqual(gate([ADVISORY], "npm"), 1)
        self.roots[1]["version"] = "1.0.9"
        self.write_lock(self.roots)
        self.assertEqual(gate([ADVISORY]), 2)


if __name__ == "__main__":
    unittest.main()
