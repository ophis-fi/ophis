#!/usr/bin/env python3
"""Run existing bridge properties offline without compiling the whole monorepo."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / 'generated'
SOLC = Path.home() / '.solc-select/artifacts/solc-0.8.28/solc-0.8.28'
assert SOLC.is_file(), 'Install solc 0.8.28 first; this check never downloads tools'
OUT.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ophis-arc-properties-') as temp:
    project = Path(temp)
    for file in ['src/contracts/AcrossMathHelper.sol', 'test/AcrossMathHelper.t.sol',
                 'test/DeployWeirollVM.t.sol', 'script/weiroll/WeirollVM.initcode']:
        target = project / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / 'contracts' / file, target)
    (project / 'lib').mkdir()
    (project / 'lib/forge-std').symlink_to(ROOT / 'contracts/lib/forge-std', target_is_directory=True)
    (project / 'foundry.toml').write_text('''[profile.default]
src="src"
test="test"
libs=["lib"]
optimizer=true
optimizer_runs=1000000
evm_version="cancun"
fs_permissions=[{access="read",path="./script/weiroll"}]
[fuzz]
runs=1024
seed="0x5042"
''')
    env = os.environ.copy()
    env['MAINNET_RPC_URL'] = ''  # Explicitly skip the existing live fork test.
    with (OUT / 'security-properties.log').open('w') as log:
        result = subprocess.run(['forge', 'test', '--root', str(project), '--use', str(SOLC),
                                 '--offline', '-vv'], cwd=project, env=env,
                                stdout=log, stderr=subprocess.STDOUT)
    print((OUT / 'security-properties.log').read_text())
    result.check_returncode()
