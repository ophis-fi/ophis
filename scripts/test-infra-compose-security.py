#!/usr/bin/env python3
"""Run with python3 scripts/test-infra-compose-security.py."""
import importlib.util
import re
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'compose_security', Path(__file__).with_name('check-infra-compose-security.py'),
)
assert spec and spec.loader
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ComposeAuthTests(unittest.TestCase):
    def test_production_auth_cannot_be_removed_or_defaulted(self):
        for path in guard.STACKS:
            text = path.read_text()
            self.assertEqual(guard.auth_errors(text), [])
            field = rf'(?m)^      {guard.TOKEN}: .*$'
            for replacement in ['', f'      # {guard.TOKEN}: ${{{guard.TOKEN}:?required}}',
                                f'      {guard.TOKEN}: ${{{guard.TOKEN}:-}}']:
                with self.subTest(stack=path.parent.name, replacement=replacement):
                    self.assertEqual(len(guard.auth_errors(re.sub(field, replacement, text))), 3)
            self.assertEqual(len(guard.auth_errors(re.sub(field, '', text, count=1))), 1)
        self.assertEqual(len(guard.auth_errors('services:\n')), 3)


if __name__ == '__main__':
    unittest.main()
