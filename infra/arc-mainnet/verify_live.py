#!/usr/bin/env python3
"""Bounded read-only Arc V3 pool/quote/router check. No keys or transactions."""
import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
OUT = HERE / 'local/generated'
USDC = '0x3600000000000000000000000000000000000000'
EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
PROBE = '0x0000000000000000000000000000000000012345'


def encode(selector, *words):
    return '0x' + selector + ''.join(format(int(w, 16) if isinstance(w, str) else w, '064x') for w in words)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Make up to 32 read-only calls to the public Arc RPC')
    args = parser.parse_args()
    if not args.live:
        parser.error('Pass --live explicitly; this is separate from the offline lab')
    # Reuse the locally tested, documented address set; never learn routers from API responses.
    manifest = json.loads((OUT / 'deployment.json').read_text())
    assert manifest['chainId'] == 5042 and manifest['localOnly'] is True
    artifacts = json.loads((OUT / 'contracts.json').read_text())['contracts']
    probe = next(v for k, v in artifacts.items() if k.endswith(':ReadOnlyV3Probe'))
    report = dict(provider='https://rpc.mainnet.arc.io', rpcRequests=0, transactions=0, venues=[])

    def rpc(method, params):
        assert method in ['eth_chainId', 'eth_getBlockByNumber', 'eth_call']
        assert report['rpcRequests'] < 32, 'Read budget exhausted'
        report['rpcRequests'] += 1
        request = Request(report['provider'], data=json.dumps(dict(jsonrpc='2.0', id=report['rpcRequests'],
                          method=method, params=params)).encode(),
                          headers={'Content-Type':'application/json', 'User-Agent':'ophis-arc-verification/1.0'})
        with urlopen(request, timeout=20) as response:
            result = json.load(response)
        if 'error' in result:
            raise ValueError(json.dumps(result['error']))
        return result['result']

    try:
        assert rpc('eth_chainId', []) == '0x13b2', 'Wrong chain'
        block = rpc('eth_getBlockByNumber', ['latest', False])
        report.update(blockNumber=int(block['number'], 16), blockHash=block['hash'], timestamp=int(block['timestamp'], 16))
        ref = dict(blockHash=block['hash'], requireCanonical=True)
        for name, venue in manifest['venues'].items():
            for fee in [100, 500]:
                row = dict(venue=name, fee=fee)
                report['venues'].append(row)
                pool = rpc('eth_call', [dict(to=venue['factory'], data=encode('1698ee82', USDC, EURC, fee)), ref])
                assert len(pool) == 66
                row['pool'] = '0x' + pool[-40:]
                if int(pool, 16) == 0:
                    continue
                row['quotesFor1000'] = {}
                for sell, buy in [(USDC, EURC), (EURC, USDC)]:
                    try:
                        data = rpc('eth_call', [dict(to=venue['quoter'], data=encode('c6a5026a', sell, buy, 10**9, fee, 0)), ref])
                        assert len(data) == 258
                        row['quotesFor1000']['USDC' if sell == USDC else 'EURC'] = int(data[2:66], 16)
                    except ValueError as error:
                        row.setdefault('quoteErrors', []).append(str(error))
                minimum = row['quotesFor1000'].get('USDC', 0)
                if minimum:
                    try:
                        data = encode('', venue['router'], fee, name == 'achswap', 10**9, minimum)
                        result = rpc('eth_call', [dict(to=PROBE, data=data), ref,
                            {PROBE:dict(code='0x'+probe['bin-runtime'], balance=hex(2000 * 10**18))}])
                        assert len(result) == 130
                        received, returned = int(result[2:66], 16), int(result[66:], 16)
                        assert received >= minimum and returned > 0
                        row['roundTrip'] = dict(eurcReceived=received, usdcReturned=returned)
                    except ValueError as error:
                        row['simulationError'] = str(error)
    finally:
        (OUT / 'live-verification.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    assert any(row['venue'] == 'uniswap-v3' and row['fee'] == 500 and 'roundTrip' in row
               for row in report['venues']), 'The initial Uniswap route did not pass simulation'


if __name__ == '__main__':
    main()
