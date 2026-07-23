#!/usr/bin/env python3
"""Static security invariants for production compose stacks."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
STACKS = [
    ROOT / 'infra' / 'hyperevm-mainnet' / 'docker-compose.yml',
    ROOT / 'infra' / 'megaeth-mainnet' / 'docker-compose.yml',
    ROOT / 'infra' / 'optimism-mainnet' / 'docker-compose.yml',
    ROOT / 'infra' / 'unichain-mainnet' / 'docker-compose.yml',
]
TRIO = ('orderbook', 'autopilot', 'driver')
TOKEN = 'OPHIS_INTER_SERVICE_AUTH_TOKEN'
ERPC_PIN = 'ERPC_IMAGE must be pinned as ghcr.io/erpc/erpc:<version>@sha256:<digest>'


def service_block(text: str, service: str) -> str:
    match = re.search(rf'^  {re.escape(service)}:\n(?P<body>(?:    .*\n|\n)*)', text, re.MULTILINE)
    if not match:
        return ''
    start = match.end()
    nxt = re.search(r'^  [A-Za-z0-9_.-]+:\n', text[start:], re.MULTILINE)
    return text[match.start(): start + (nxt.start() if nxt else len(text[start:]))]

errors: list[str] = []
for path in STACKS:
    text = path.read_text()
    if 'ghcr.io/erpc/erpc:latest' in text:
        errors.append(f'{path.relative_to(ROOT)} uses mutable ghcr.io/erpc/erpc:latest')
    if 'rpc-proxy:' in text and ERPC_PIN not in text:
        errors.append(f'{path.relative_to(ROOT)} has rpc-proxy but does not require a pinned ERPC_IMAGE')

    present = {svc: TOKEN in service_block(text, svc) for svc in TRIO if service_block(text, svc)}
    if present and len(set(present.values())) != 1:
        errors.append(f'{path.relative_to(ROOT)} has partial {TOKEN} coverage: {present}')

if errors:
    for error in errors:
        print(f'ERROR: {error}', file=sys.stderr)
    sys.exit(1)
print('infra compose security invariants passed')
