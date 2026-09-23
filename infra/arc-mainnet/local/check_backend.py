#!/usr/bin/env python3
"""Exercise the real local orderbook/driver/solver against fixture liquidity."""
import json
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
m = json.loads((HERE / 'generated/deployment.json').read_text())
lanes = json.loads((HERE / 'generated/lanes.json').read_text())
venues = {name: m['venues'][name] for name, _ in lanes if name in m['venues']}
USDC = '0x3600000000000000000000000000000000000000'
EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'


def rpc(method, params):
    request = Request('http://127.0.0.1:8547', data=json.dumps(dict(jsonrpc='2.0', id=1,
                      method=method, params=params)).encode(), headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=5) as response:
        result = json.load(response)
    assert 'error' not in result, result
    return result['result']


def quote(amount, **overrides):
    data = dict(sellToken=USDC, buyToken=EURC, kind='sell', sellAmountBeforeFee=str(amount),
                validFor=1800, priceQuality='optimal', signingScheme='eip712', **{'from': m['trader']})
    data.update(overrides)
    req = Request('http://127.0.0.1:8087/api/v1/quote', data=json.dumps(data).encode(),
                  headers={'Content-Type': 'application/json'})
    try:
        with urlopen(req, timeout=30) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


status, result = quote(10_000_000)
assert status == 200 and result['verified'] is True, (status, result)
q = result['quote']
quote_id = result['id']
assert Decimal(q['sellTokenPrice']) == Decimal(10)**12, q
fee = (Decimal(q['gasAmount']) * Decimal(q['gasPrice']) / Decimal(10)**12).to_integral_value(rounding=ROUND_CEILING)
assert abs(int(q['feeAmount']) - int(fee)) <= 1, q
assert int(q['buyAmount']) > 9_000_000, q
# More than the Anvil trader owns: verifies Arc native-balance override and
# the Trader helper's no-deposit() path, without minting user funds.
status, result = quote(100_000_000_000)
assert status == 200 and result['verified'] is True, (status, result)
for field in ['buyToken', 'sellToken']:
    status, result = quote(10_000_000, **{field: NATIVE})
    assert status == 400, (field, status, result)
print('PASS: verified Arc quotes, native/USDC fee conversion, insufficient-balance simulation, native sentinel rejection')

# Automatic mode gets its signed order from check_browser.cjs, avoiding a
# competing startup probe during execution measurements.
if not m.get('automaticSettlement', False):
    # Sign only with the disposable Anvil trader, then exercise real order validation.
    order_fields = [('sellToken', 'address'), ('buyToken', 'address'), ('receiver', 'address'),
                    ('sellAmount', 'uint256'), ('buyAmount', 'uint256'), ('validTo', 'uint32'),
                    ('appData', 'bytes32'), ('feeAmount', 'uint256'), ('kind', 'string'),
                    ('partiallyFillable', 'bool'), ('sellTokenBalance', 'string'), ('buyTokenBalance', 'string')]
    order = {name: q[name] for name, _ in order_fields}
    order['receiver'] = order['receiver'] or '0x' + '0' * 40
    # Current CoW orders use dynamic solver fees: include quoted fee in sell amount.
    order['sellAmount'] = str(int(order['sellAmount']) + int(order['feeAmount']))
    order['feeAmount'] = '0'
    payload = dict(types={
        'EIP712Domain': [dict(name=n, type=t) for n, t in [('name','string'), ('version','string'), ('chainId','uint256'), ('verifyingContract','address')]],
        'Order': [dict(name=n, type=t) for n, t in order_fields]}, primaryType='Order',
        domain=dict(name='Gnosis Protocol', version='v2', chainId=5042, verifyingContract=m['settlement']), message=order)
    request = Request('http://127.0.0.1:8547', data=json.dumps(dict(jsonrpc='2.0', id=1,
                      method='eth_signTypedData_v4', params=[m['trader'], json.dumps(payload)])).encode(),
                      headers={'Content-Type':'application/json'})
    with urlopen(request, timeout=5) as response:
        signature = json.load(response)['result']
    order.update(signingScheme='eip712', signature=signature, quoteId=quote_id)
    request = Request('http://127.0.0.1:8087/api/v1/orders', data=json.dumps(order).encode(), headers={'Content-Type':'application/json'})
    try:
        with urlopen(request, timeout=30) as response:
            assert response.status == 201
            uid = json.load(response)
            assert len(uid) == 114  # order UID: digest + owner + validTo
    except HTTPError as error:
        raise AssertionError((error.code, error.read().decode())) from error
    print('PASS: local EIP-712 order accepted with Arc domain, ERC20 allowance and balance validation')
    # This probe checks acceptance, then cancels before rate-changing tests. The
    # browser test separately exercises automatic execution with its own account.
    cancellation = dict(orderUids=[uid])
    payload.update(primaryType='OrderCancellations', message=cancellation,
                   types={'EIP712Domain':payload['types']['EIP712Domain'],
                          'OrderCancellations':[dict(name='orderUids', type='bytes[]')]})
    cancellation.update(signature=rpc('eth_signTypedData_v4', [m['trader'], json.dumps(payload)]), signingScheme='eip712')
    request = Request('http://127.0.0.1:8087/api/v1/orders', method='DELETE',
                      data=json.dumps(cancellation).encode(), headers={'Content-Type':'application/json'})
    with urlopen(request, timeout=10) as response:
        assert response.status == 200
    print('PASS: probe order cancelled before liquidity fixture changes')


# Each direct lane must return the pinned router's ABI in both directions.
for name, venue in venues.items():
    for sell, buy in [(USDC, EURC), (EURC, USDC)]:
        params = urlencode(dict(sellToken=sell, buyToken=buy, amount='1000000', kind='sell',
                                deadline=(datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat()))
        with urlopen(f'http://127.0.0.1:11087/{name}/quote?{params}', timeout=30) as response:
            route = json.load(response)
        swaps = [i for i in route['interactions'] if i['target'].lower() == venue['router'].lower()]
        assert len(swaps) == 1, route
        call = swaps[0]
        data = bytes.fromhex(call['callData'][2:])
        legacy = name == 'achswap'
        assert data[:4].hex() == ('414bf389' if legacy else '04e45aaf'), call
        assert len(data) == 4 + 32 * (8 if legacy else 7), call
        words = [int.from_bytes(data[i:i+32], 'big') for i in range(4, len(data), 32)]
        assert words[:4] == [int(sell, 16), int(buy, 16), 500, int(m['settlement'], 16)], call
        assert words[-3:] == [1000000, 1000000, 0] and int(call['value']) == 0, call
        if legacy:
            assert words[4] == 2**256 - 1
print('PASS: all direct DEX lanes quote both directions with pinned recipients and Router02/legacy calldata')


def rate(venue, bps):
    for role in ['quoter', 'router']:
        tx = rpc('eth_sendTransaction', [{'from': m['manager'], 'to': m['venues'][venue][role],
                                          'data': '0x34fcf437' + format(bps, '064x')}])
        for _ in range(100):
            receipt = rpc('eth_getTransactionReceipt', [tx])
            if receipt is not None:
                break
            time.sleep(.05)
        assert receipt is not None and int(receipt['status'], 16) == 1, receipt


aggregators = [name for name, _ in lanes if name in ['lifi', 'kyberswap']]
for name in aggregators:
    target = {'lifi': '0xa4072583658fae592a3506a42431cb6316a8d40b',
              'kyberswap': '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'}[name]
    for sell, buy in [(USDC, EURC), (EURC, USDC)]:
        params = urlencode(dict(sellToken=sell, buyToken=buy, amount='1000000', kind='sell',
                                deadline=(datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat()))
        with urlopen(f'http://127.0.0.1:11087/{name}/quote?{params}', timeout=30) as response:
            route = json.load(response)
        swaps = [i for i in route['interactions'] if i['target'].lower() == target]
        assert len(swaps) == 1 and int(swaps[0]['value']) == 0, route
        data = bytes.fromhex(swaps[0]['callData'][2:])
        assert len(data) == 4 + 32 * 4, swaps
        words = [int.from_bytes(data[i:i+32], 'big') for i in range(4, len(data), 32)]
        assert words == [int(sell, 16), 1000000, 1000000, int(m['settlement'], 16)], swaps
print('PASS: optional aggregator connectors quote both directions against loopback fixtures:', aggregators)
if len(venues) > 1:
    try:
        rate('uniswap-v3', 9000)
        rate('synthra', 9500)
        rate('achswap', 10000)
        status, result = quote(100_000_001)
        assert status == 200 and result['verified'], (status, result)
        assert int(result['quote']['buyAmount']) / int(result['quote']['sellAmount']) > .999, result
        rate('achswap', 0)  # no valid quote; another solver must still serve the order
        status, result = quote(100_000_002)
        assert status == 200 and result['verified'], (status, result)
        ratio = int(result['quote']['buyAmount']) / int(result['quote']['sellAmount'])
        assert (.949 < ratio < .951) if not aggregators else ratio > .999, result
    finally:
        for venue in m['venues']:
            rate(venue, 10000)
    print('PASS: quote competition chooses better output and tolerates a failed venue; optional competitors:', aggregators)
