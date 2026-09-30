#!/usr/bin/env python3
"""Offline guards for local signer configuration and venue selection."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
try:
    import tomllib
except ImportError:
    import tomli as tomllib

HERE = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    shutil.copy(HERE / 'render.py', root / 'render.py')
    out = root / 'generated'
    out.mkdir()
    address = '0x' + '1' * 40
    manifest = dict(localOnly=True, chainId=5042, rpc='http://127.0.0.1:8547',
                    **{key:address for key in ['solver','settlement','Balances','Signatures','HooksTrampoline','vault']})

    def render(*flags, succeeds=True):
        (out / 'deployment.json').write_text(json.dumps(manifest))
        result = subprocess.run(['python3', root / 'render.py', *flags], capture_output=True)
        assert (result.returncode == 0) == succeeds, result.stderr.decode()

    render()
    policy = tomllib.loads((out / 'autopilot.toml').read_text())['fee-policies']
    for chain, filename in [('optimism', 'autopilot.toml'), ('unichain', 'autopilot.toml.tmpl'), ('robinhood', 'autopilot.toml.tmpl')]:
        reference = HERE.parents[1] / f'{chain}-mainnet/configs' / filename
        assert policy == tomllib.loads(reference.read_text())['fee-policies'], chain
    driver = (out / 'driver.toml').read_text()
    assert f'account = "{address}"' in driver and 'guarded = {' not in driver
    assert len(json.loads((out / 'lanes.json').read_text())) == 3
    render('--automatic-settlement', succeeds=False)
    manifest['automaticSettlement'] = True
    render(succeeds=False)
    render('--automatic-settlement', succeeds=False)  # No key file.
    (out / 'anvil-solver.key').write_text('disposable-test-key')
    render('--automatic-settlement', '--uniswap-only')
    assert tomllib.loads((out / 'autopilot.toml').read_text())['fee-policies'] == policy
    driver = (out / 'driver.toml').read_text()
    assert 'guarded = { path =' in driver and 'require-zero-value = true' in driver
    assert 'selectors = ["0x13d79a0b"]' in driver
    assert json.loads((out / 'lanes.json').read_text()) == [['uniswap-v3',7880]]
    assert 'submission-deadline = 120' in (out / 'autopilot.toml').read_text()
    for field,value in [('rpc','https://rpc.mainnet.arc.io'),('chainId',1),('localOnly',False)]:
        previous = manifest[field]
        manifest[field] = value
        render('--automatic-settlement', succeeds=False)
        manifest[field] = previous
print('PASS: default dry-run, local guarded signer, single venue, and remote/chain/mode rejection')
