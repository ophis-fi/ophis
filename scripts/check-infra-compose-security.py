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
    ROOT / 'infra' / 'robinhood-mainnet' / 'docker-compose.yml',
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


def has_directly_pinned_erpc_image(block: str) -> bool:
    """Match only the active Compose image field, never comments or other scalars."""
    return bool(re.search(
        r'(?m)^    image:\s*(?P<quote>["\']?)'
        r'ghcr\.io/erpc/erpc(?:[:][^@\s"\']+)?@sha256:[0-9a-f]{64}'
        r'(?P=quote)\s*(?:#.*)?$',
        block,
    ))


errors: list[str] = []
for path in STACKS:
    text = path.read_text()
    if 'ghcr.io/erpc/erpc:latest' in text:
        errors.append(f'{path.relative_to(ROOT)} uses mutable ghcr.io/erpc/erpc:latest')
    rpc_proxy = service_block(text, 'rpc-proxy')
    directly_pinned_erpc = has_directly_pinned_erpc_image(rpc_proxy)
    if rpc_proxy and ERPC_PIN not in text and not directly_pinned_erpc:
        errors.append(f'{path.relative_to(ROOT)} has rpc-proxy but does not require a pinned ERPC_IMAGE')

    present = {svc: TOKEN in service_block(text, svc) for svc in TRIO if service_block(text, svc)}
    if present and len(set(present.values())) != 1:
        errors.append(f'{path.relative_to(ROOT)} has partial {TOKEN} coverage: {present}')

    if path.parent.name == 'robinhood-mainnet':
        for svc in TRIO:
            block = service_block(text, svc)
            if 'ophis-rbh-net' in block:
                errors.append(
                    f'{path.relative_to(ROOT)} exposes signing service {svc} to ophis-rbh-net'
                )
            if f'{TOKEN}: ${{{TOKEN}:?' not in block:
                errors.append(
                    f'{path.relative_to(ROOT)} permits {svc} without mandatory {TOKEN}'
                )
        nitro_compose = path.parent / 'nitro' / 'docker-compose.yml'
        nitro_text = nitro_compose.read_text()
        if '--execution.forwarding-target=null' in nitro_text:
            errors.append(
                f'{nitro_compose.relative_to(ROOT)} disables settlement transaction forwarding'
            )
        if '--execution.forwarding-target=${ROBINHOOD_TX_FORWARDING_TARGET:?' not in nitro_text:
            errors.append(
                f'{nitro_compose.relative_to(ROOT)} does not require a transaction forwarding target'
            )
        nitro_env = path.parent / 'nitro' / '.env.example'
        if 'ROBINHOOD_TX_FORWARDING_TARGET=' not in nitro_env.read_text():
            errors.append(
                f'{nitro_env.relative_to(ROOT)} does not document the transaction forwarding target'
            )
        refunder = service_block(text, 'refunder')
        required_refunder_fields = (
            'CHAIN_ID: "4663"',
            'ETHFLOW_CONTRACTS: "0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29"',
            'REFUNDER_PK: ${OPHIS_REFUNDER_PK:?',
            'MIN_PRICE_DEVIATION_BPS: "-1000000"',
        )
        for field in required_refunder_fields:
            if field not in refunder:
                errors.append(
                    f'{path.relative_to(ROOT)} Robinhood refunder is missing {field}'
                )
        for solver_config in ('lifi.toml.tmpl', 'kyberswap.toml.tmpl', 'uniswap-v4.toml.tmpl'):
            config_path = path.parent / 'configs' / solver_config
            config_text = config_path.read_text()
            if 'wrapped-native-balance-slot = 51' not in config_text:
                errors.append(
                    f'{config_path.relative_to(ROOT)} does not use the verified aeWETH balance slot 51'
                )

if errors:
    for error in errors:
        print(f'ERROR: {error}', file=sys.stderr)
    sys.exit(1)
print('infra compose security invariants passed')
