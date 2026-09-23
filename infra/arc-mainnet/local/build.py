#!/usr/bin/env python3
"""Build local Arc services with bounded parallelism and a free-space check."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
GIB = 1024**3


def check_space(path, minimum=3 * GIB):
    free = shutil.disk_usage(path).free
    if free < minimum:
        raise SystemExit(f'Build stopped: {free / GIB:.1f} GiB free at {path}; need at least {minimum / GIB:.0f} GiB.')
    print(f'Disk check: {free / GIB:.1f} GiB free at {path}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    backend = ROOT / 'apps/backend'
    # ponytail: conservative floor for this cached build; a fresh build needs more.
    target = backend / os.environ.get('CARGO_TARGET_DIR', 'target')
    target.mkdir(parents=True, exist_ok=True)
    check_space(backend)
    check_space(target, (3 if (target / 'debug/deps').is_dir() else 12) * GIB)
    if not args.check_only:
        subprocess.run(['cargo', 'build', '--locked', '--jobs', '2', '-p', 'orderbook',
                        '-p', 'autopilot', '-p', 'driver', '-p', 'solvers', '--bins'],
                       cwd=backend, check=True,
                       env={**os.environ, 'CARGO_PROFILE_DEV_DEBUG': '0', 'CARGO_INCREMENTAL': '0'})
