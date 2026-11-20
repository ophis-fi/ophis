#!/usr/bin/env python3
"""Private metered RPC lanes (dRPC, Validation Cloud). Reserve CU BEFORE every attempt."""
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# Keyless dRPC: 20 CU per allowed method. 400k CU/day bounds any 31-day month to
# 12.4M CU (under 6% of the 210M free pool). The minute cap (250 reads) lets dRPC
# pair with Validation Cloud when every free voter is rate-limited.
DRPC = {'credits': 20, 'minute': 5000, 'day': 400_000}
VALIDATIONCLOUD_URL = re.compile(r'https://mainnet\.arc\.validationcloud\.io/v1/[A-Za-z0-9_-]{20,}')
# Validation Cloud's free team gets 50M CU per UTC month and is disabled when it
# runs out. Its docs price eth_call, eth_estimateGas and eth_getBlockByNumber at
# 40 CU; every allowed read is charged 40. 1.5M CU per UTC day bounds any month
# to 46.5M CU without tracking the reset date; the minute cap is 500 reads.
VALIDATIONCLOUD = {'credits': 40, 'minute': 20_000, 'day': 1_500_000}


class Budget:
    def __init__(self, path, allowance, minute=DRPC['minute'], day=DRPC['day']):
        # allowance=None: no lifetime ledger; the daily cap alone bounds monthly use.
        if allowance is not None and not 0 < allowance <= 180_000_000:
            raise ValueError('Reserve 1..180000000 CU; leave at least 30M of the 210M free pool unallocated')
        self.path, self.allowance, self.minute, self.day = path, allowance, minute, day
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL, minute INTEGER NOT NULL, minute_used INTEGER NOT NULL, day INTEGER NOT NULL, day_used INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO usage VALUES (1,0,0,0,0,0)')

    def reserve(self, credits, now=None):
        if not isinstance(credits, int) or credits <= 0:
            raise ValueError('Positive integer credit cost required')
        now = int(time.time() if now is None else now)
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.execute('BEGIN IMMEDIATE')
            total, minute, minute_used, day, day_used = db.execute('SELECT total,minute,minute_used,day,day_used FROM usage WHERE id=1').fetchone()
            minute_used = minute_used if minute == now // 60 else 0
            day_used = day_used if day == now // 86400 else 0
            if (self.allowance is not None and total + credits > self.allowance) or \
                    minute_used + credits > self.minute or day_used + credits > self.day:
                return False
            db.execute('UPDATE usage SET total=?,minute=?,minute_used=?,day=?,day_used=? WHERE id=1',
                       (total + credits, now // 60, minute_used + credits, now // 86400, day_used + credits))
            return True


def read_block(block):
    if isinstance(block, str):
        return bool(re.fullmatch(r'latest|pending|finalized|safe|earliest|0x[0-9a-fA-F]+', block))
    # Direct pool reads pin by EIP-1898 hash; quote simulations also use numbers.
    if isinstance(block, dict):
        if set(block) == {'blockNumber'}:
            return bool(re.fullmatch(r'0x[0-9a-fA-F]+', str(block['blockNumber'])))
        if set(block) in ({'blockHash'}, {'blockHash', 'requireCanonical'}):
            return bool(re.fullmatch(r'0x[0-9a-fA-F]{64}', str(block['blockHash']))) and isinstance(block.get('requireCanonical', False), bool)
    return False


def cost(payload):
    if not isinstance(payload, dict) or payload.get('jsonrpc') != '2.0':
        raise ValueError('Single JSON-RPC requests only')
    method, params = payload.get('method'), payload.get('params', [])
    if not isinstance(params, list):
        raise ValueError('Expected positional parameters')
    if method == 'debug_traceTransaction':
        if not isinstance(params, list) or len(params) != 2 or not re.fullmatch(r'0x[0-9a-fA-F]{64}', str(params[0])):
            raise ValueError('Expected transaction hash and callTracer options')
        if not isinstance(params[1], dict) or params[1].get('tracer') != 'callTracer' or set(params[1]) - {'tracer', 'timeout', 'tracerConfig'}:
            raise ValueError('Only callTracer is enabled')
        return 20
    if method in ('eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice') and params == []:
        return 20
    if method == 'eth_getBlockByNumber' and isinstance(params, list) and len(params) == 2 and params[1] is False and re.fullmatch(r'latest|finalized|safe|0x[0-9a-fA-F]+', str(params[0])):
        return 20
    if method in ('eth_getBalance', 'eth_getCode') and len(params) == 2:
        if re.fullmatch(r'0x[0-9a-fA-F]{40}', str(params[0])) and read_block(params[1]):
            return 20
    if method == 'eth_estimateGas' and len(params) == 1 and isinstance(params[0], dict):
        return 20
    if method in ('eth_call', 'eth_estimateGas') and len(params) in (2, 3):
        # Read-only EVM execution, including the quote verifier's state overrides.
        # The node validates transaction/override fields; never relay or sign here.
        if isinstance(params[0], dict) and read_block(params[1]) and (len(params) == 2 or isinstance(params[2], dict)):
            return 20
    raise ValueError('Method denied on the dRPC lane')


def validationcloud_cost(payload):
    # Same read-only boundary as dRPC; traces stay on dRPC.
    cost(payload)
    if payload['method'] == 'debug_traceTransaction':
        raise ValueError('Method denied on the Validation Cloud lane')
    return VALIDATIONCLOUD['credits']


def serve():
    database = os.environ.get('ARC_CREDIT_DB', '/data/credits.sqlite')
    lane = os.environ.get('ARC_GATE_LANE', 'drpc')
    if lane == 'drpc':
        name, endpoint, price = 'dRPC', 'https://arc.drpc.org', cost
        budget = Budget(database, int(os.environ['ARC_DRPC_CU_ALLOWANCE']))
    elif lane == 'validationcloud':
        # The URL carries the API key: never log it or echo it in errors.
        endpoint = os.environ['ARC_VALIDATIONCLOUD_URL']
        if not VALIDATIONCLOUD_URL.fullmatch(endpoint):
            raise ValueError('ARC_VALIDATIONCLOUD_URL must be a keyed Validation Cloud Arc mainnet URL')
        name, price = 'Validation Cloud', validationcloud_cost
        budget = Budget(database, None, VALIDATIONCLOUD['minute'], VALIDATIONCLOUD['day'])
    else:
        raise ValueError('ARC_GATE_LANE must be drpc or validationcloud')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            raise ValueError('Redirect denied: each reservation permits one upstream attempt')
    opener = urllib.request.build_opener(NoRedirect)
    slots = threading.BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Never log credentials or signed payloads.

        def do_POST(self):
            request_id = None
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 65536:
                    raise ValueError('Invalid body size')
                payload = json.loads(self.rfile.read(size))
                request_id = payload.get('id') if isinstance(payload, dict) else None
                credits = price(payload)
                with slots:
                    if not budget.reserve(credits):
                        raise ValueError('reserved CU budget exhausted')
                    # dRPC rejects urllib's default user agent with HTTP 403.
                    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'ophis-arc-rpc/1.0'})
                    with opener.open(request, timeout=10) as response:
                        body = response.read(8 * 1024 * 1024 + 1)
                    if len(body) > 8 * 1024 * 1024:
                        raise ValueError('RPC response too large')
                json.loads(body)
            except Exception:
                # Failed/time-out calls remain charged; retries must reserve again.
                body = json.dumps({'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32005, 'message': name + ' lane unavailable or CU budget exhausted'}}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()


if __name__ == '__main__':
    serve()
