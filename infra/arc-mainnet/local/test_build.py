"""Run with python3 infra/arc-mainnet/local/test_build.py; no build or disk writes."""
from types import SimpleNamespace
from unittest.mock import patch
from build import GIB, ROOT, check_space

with patch('build.shutil.disk_usage', return_value=SimpleNamespace(free=3 * GIB - 1)):
    try:
        check_space(ROOT)
    except SystemExit as error:
        assert 'Build stopped' in str(error)
    else:
        raise AssertionError('Low disk was accepted')
with patch('build.shutil.disk_usage', return_value=SimpleNamespace(free=3 * GIB)):
    check_space(ROOT)
print('PASS: disk guard threshold')
