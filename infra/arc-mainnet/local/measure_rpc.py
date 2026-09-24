#!/usr/bin/env python3
"""Count backend RPC traffic during idle and one verified quote, using local Anvil only."""
from collections import Counter
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

OUT = Path(__file__).resolve().parent / 'generated'


def read(url, data=None):
    req = Request(url, data=json.dumps(data).encode() if data else None,
                  headers={'Content-Type': 'application/json'})
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def counts():
    return Counter(read('http://127.0.0.1:8548/counts'))


def measure(action):
    before = counts()
    start = time.monotonic()
    action()
    delta = counts() - before
    return dict(seconds=time.monotonic()-start, total=sum(delta.values()), methods=dict(delta))


def quote():
    m = json.loads((OUT / 'deployment.json').read_text())
    assert m['localOnly'] and m['rpc'] == 'http://127.0.0.1:8547'
    response = read('http://127.0.0.1:8087/api/v1/quote', dict(
        sellToken='0x3600000000000000000000000000000000000000',
        buyToken='0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
        sellAmountBeforeFee='123456789', kind='sell', validFor=1800,
        priceQuality='optimal', signingScheme='eip712', **{'from':m['trader']}))
    assert response['verified'] is True


if __name__ == '__main__':
    # Counter regression: a JSON-RPC batch is two billable requests, not one HTTP call.
    before = counts()
    response = read('http://127.0.0.1:8548', [dict(jsonrpc='2.0', id=i,
                    method='web3_clientVersion', params=[]) for i in [1, 2]])
    assert len(response) == 2 and all('anvil' in item['result'].lower() for item in response)
    assert counts()['web3_clientVersion'] - before['web3_clientVersion'] == 2
    idle = measure(lambda: time.sleep(60))
    assert not idle['methods'].get('eth_sendRawTransaction'), 'Wait for test orders to settle/cancel before measuring idle'
    report = {'idle': idle, 'quote': measure(quote),
              'scope': 'All backend RPC attempts, including background polling and each batch element. '
                       'Excludes direct browser/deployment/test assertion calls to Anvil.'}
    (OUT / 'rpc-usage.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))
