#!/usr/bin/env python3
"""Render disposable active releases; no keys, RPC or deployment commands."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

import render


class RuntimeFeeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.out = Path(self.directory.name)
        self.override = patch.object(render, 'OUT', self.out)
        self.override.start()
        self.addCleanup(self.override.stop)
        self.commands = patch.object(render.subprocess, 'run')
        self.commands.start()
        self.addCleanup(self.commands.stop)
        config = json.loads((render.HERE / 'config.example.json').read_text())
        config['solver'] = '0x' + '33' * 20
        contracts = {name: '0x' + '44' * 20 for name in
                     ['settlement', 'Balances', 'Signatures', 'HooksTrampoline', 'vault', 'vaultRelayer']}
        self.plan = {'config': config, 'contracts': contracts, 'hash': 'disposable-plan'}
        (self.out / 'plan.json').write_text(json.dumps(self.plan))
        (self.out / 'verified.json').write_text(json.dumps({
            'planHash': self.plan['hash'], 'localOnly': False, 'contracts': contracts,
            'solver': config['solver'], 'settlementDeploymentBlock': 1,
            'verifiedAt': datetime.now(timezone.utc).isoformat(),
        }))

    def run_render(self):
        with contextlib.redirect_stdout(io.StringIO()):
            render.render(active=True)
        return render.tomllib.loads((self.out / 'driver.toml').read_text())

    def test_first_activation_uses_plan(self):
        self.assertEqual(self.run_render()['submission']['gas-price-cap'], '25000000000')

    def test_rerender_preserves_runtime_cap_and_deployment_plan(self):
        plan = (self.out / 'plan.json').read_bytes()
        (self.out / 'driver.toml').write_text('[submission]\ngas-price-cap = "30000000000"\n')
        for _ in range(2):
            config = self.run_render()
            self.assertEqual(config['submission']['gas-price-cap'], '30000000000')
            self.assertEqual(config['tx-gas-limit'], '10000000')
            self.assertTrue(all('guarded' in solver['account'] for solver in config['solver']))
            self.assertEqual((self.out / 'plan.json').read_bytes(), plan)

    def test_invalid_runtime_caps_fail_before_writing(self):
        for value in ['"0"', '"100000000001"', '"abc"', '"３０"', '30000000000', '30.0']:
            with self.subTest(value=value):
                (self.out / 'driver.toml').write_text('[submission]\ngas-price-cap = ' + value + '\n')
                before = {p.name: p.read_bytes() for p in self.out.iterdir()}
                with self.assertRaises(AssertionError):
                    self.run_render()
                self.assertEqual({p.name: p.read_bytes() for p in self.out.iterdir()}, before)


if __name__ == '__main__':
    unittest.main()
