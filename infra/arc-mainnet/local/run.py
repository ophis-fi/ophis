#!/usr/bin/env python3
"""Disposable, loopback-only Arc lab. No production URL or signing key input."""
import argparse
import json
from pathlib import Path
from build import check_space
import socket
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / 'generated'
OUT.mkdir(exist_ok=True)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--anvil', default='anvil', help='Arc Foundry anvil executable')
parser.add_argument('--with-lifi', action='store_true', help='Include LI.FI as an optional competing solver fixture')
parser.add_argument('--with-kyberswap', action='store_true', help='Include KyberSwap as an optional competing solver fixture')
parser.add_argument('--serve', action='store_true', help='Keep the lab running after checks; Ctrl-C stops it')
parser.add_argument('--automatic-settlement', action='store_true', help='Sign settlements with the disposable Anvil account only')
parser.add_argument('--uniswap-only', action='store_true', help='Use only the direct venue verified by the live pool checks')
args = parser.parse_args()
check_space(ROOT)
processes = []
logs = []
db = 'ophis-arc-lab-' + uuid.uuid4().hex[:8]
created_db = False


def run(command):
    subprocess.run([str(x) for x in command], cwd=ROOT, check=True)


def start(name, command):
    log = (OUT / f'{name}.log').open('w')
    logs.append(log)
    proc = subprocess.Popen([str(x) for x in command], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    processes.append(proc)
    return proc


def wait_port(port, process=None):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError(f'Service exited: inspect {OUT}')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                return
        except OSError:
            time.sleep(.1)
    raise TimeoutError(f'Local port {port} did not start')


# Never attach this test to another existing node/backend/database.
for port in [8547, 8548, 15447, 8787, 8788, 7877, 7878, 7879, 7880, 7881, 11087, 12087, 8087, 9587, 9586]:
    with socket.socket() as check:
        check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        check.bind(('127.0.0.1', port))
try:
    anvil = start('anvil', [args.anvil, '--network', 'arc', '--chain-id', '5042',
                           '--host', '127.0.0.1', '--port', '8547', '--silent'])
    wait_port(8547, anvil)
    run([HERE / 'build-contracts.sh'])
    automatic = ['--automatic-settlement'] if args.automatic_settlement else []
    run(['node', HERE / 'deploy.cjs', *automatic])
    wait_port(8548, start('rpc-meter', ['python3', HERE / 'rpc_meter.py']))
    flags = [flag for flag, enabled in [('--with-lifi', args.with_lifi), ('--with-kyberswap', args.with_kyberswap),
                                      ('--uniswap-only', args.uniswap_only)] if enabled]
    run(['python3', HERE / 'render.py', *flags, *automatic])
    run(['docker', 'run', '-d', '--name', db, '-p', '127.0.0.1:15447:5432',
         '-e', 'POSTGRES_USER=arc', '-e', 'POSTGRES_PASSWORD=arc-local', '-e', 'POSTGRES_DB=arc', 'postgres:16-alpine'])
    created_db = True
    wait_port(15447)
    # Existing project migration image, but mount this checkout's exact migrations.
    run(['docker', 'run', '--rm', '--network', 'container:' + db,
         '-v', f'{ROOT}/apps/backend/database/sql:/flyway/sql:ro',
         '-v', f'{ROOT}/apps/backend/database/conf:/flyway/conf:ro',
         '-e', 'FLYWAY_URL=jdbc:postgresql://127.0.0.1:5432/arc?user=arc&password=arc-local',
         '-e', 'FLYWAY_CONNECT_RETRIES=10', 'backend-migrations:latest', 'migrate'])
    if args.with_lifi:
        wait_port(8787, start('mock-lifi', ['node', HERE / 'mock-lifi.cjs']))
    if args.with_kyberswap:
        wait_port(8788, start('mock-kyberswap', ['node', HERE / 'mock-kyberswap.cjs']))
    binary = ROOT / 'apps/backend/target/debug'
    for name, port in json.loads((OUT / 'lanes.json').read_text()):
        wait_port(port, start(name, [binary / 'solvers', '--addr', f'127.0.0.1:{port}',
                                    name if name in ['lifi', 'kyberswap'] else 'directv3', '--config', OUT / f'{name}.toml']))
    wait_port(11087, start('driver', [binary / 'driver', '--addr', '127.0.0.1:11087', '--ethrpc', 'http://127.0.0.1:8548',
                                    '--block-stream-poll-interval', '30s', '--ethrpc-max-concurrent-requests', '2',
                                    '--config', OUT / 'driver.toml']))
    wait_port(12087, start('autopilot', [binary / 'autopilot', '--config', OUT / 'autopilot.toml']))
    wait_port(8087, start('orderbook', [binary / 'orderbook', '--config', OUT / 'orderbook.toml']))
    run(['python3', HERE / 'check_backend.py'])
    print(f'PASS: local Arc lab; automatic settlement={args.automatic_settlement}. Mainnet remains disabled.', flush=True)
    if args.serve:
        print(f'Frontend environment: {OUT / "frontend.env"}', flush=True)
        while all(p.poll() is None for p in processes):
            time.sleep(1)
except KeyboardInterrupt:
    # The finally block terminates every disposable lab process.
    pass
finally:
    for process in reversed(processes):
        process.terminate()
    for process in processes:
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    for log in logs:
        log.close()
    (OUT / 'anvil-solver.key').unlink(missing_ok=True)
    if created_db:
        subprocess.run(['docker', 'rm', '-f', db], check=True, stdout=subprocess.DEVNULL)
