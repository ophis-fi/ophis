#!/usr/bin/env python3
"""Private QuickNode trace lane. Reserve credits durably BEFORE every attempt."""
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Budget:
    def __init__(self, path, allowance):
        if not 0 < allowance <= 10_000_000:
            raise ValueError('Set a reserved remaining credit allowance between 1 and 10000000')
        self.path, self.allowance = path, allowance
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL, minute INTEGER NOT NULL, minute_used INTEGER NOT NULL, day INTEGER NOT NULL, day_used INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO usage VALUES (1,0,0,0,0,0)')

    def reserve(self, credits, now=None):
        if not isinstance(credits, int) or credits <= 0:
            raise ValueError('Positive integer credit cost required')
        now = int(time.time() if now is None else now)
        with sqlite3.connect(self.path, timeout=5) as db:
            db.execute('BEGIN IMMEDIATE')
            total, minute, minute_used, day, day_used = db.execute('SELECT total,minute,minute_used,day,day_used FROM usage WHERE id=1').fetchone()
            minute_used = minute_used if minute == now // 60 else 0
            day_used = day_used if day == now // 86400 else 0
            if total + credits > self.allowance or minute_used + credits > 1000 or day_used + credits > 40000:
                return False
            db.execute('UPDATE usage SET total=?,minute=?,minute_used=?,day=?,day_used=? WHERE id=1',
                       (total + credits, now // 60, minute_used + credits, now // 86400, day_used + credits))
            return True


def cost(payload):
    if not isinstance(payload, dict) or payload.get('jsonrpc') != '2.0':
        raise ValueError('Single JSON-RPC requests only')
    method, params = payload.get('method'), payload.get('params', [])
    if method == 'debug_traceTransaction':
        if not isinstance(params, list) or len(params) != 2 or not re.fullmatch(r'0x[0-9a-fA-F]{64}', str(params[0])):
            raise ValueError('Expected transaction hash and callTracer options')
        if not isinstance(params[1], dict) or params[1].get('tracer') != 'callTracer' or set(params[1]) - {'tracer', 'timeout', 'tracerConfig'}:
            raise ValueError('Only callTracer is enabled')
        return 40
    if method in ('eth_chainId', 'net_version', 'eth_blockNumber') and params == []:
        return 20
    if method == 'eth_getBlockByNumber' and isinstance(params, list) and len(params) == 2 and params[1] is False and re.fullmatch(r'latest|finalized|safe|0x[0-9a-fA-F]+', str(params[0])):
        return 20
    raise ValueError('Method denied on the paid lane')


def serve():
    endpoint = os.environ['ARC_QUICKNODE_RPC_URL']
    url = urlsplit(endpoint)
    if url.scheme != 'https' or not (url.hostname or '').endswith('.arc-mainnet.quiknode.pro') or url.username or url.password or url.query or url.fragment or url.port not in (None, 443):
        raise ValueError('Expected a private Arc QuickNode HTTPS endpoint')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            raise ValueError('Redirect denied: each reservation permits one upstream attempt')
    opener = urllib.request.build_opener(NoRedirect)
    budget = Budget(os.environ.get('ARC_CREDIT_DB', '/data/credits.sqlite'), int(os.environ['ARC_QUICKNODE_CREDIT_ALLOWANCE']))
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
                credits = cost(payload)
                with slots:
                    if not budget.reserve(credits):
                        raise ValueError('QuickNode reserved budget exhausted')
                    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
                    with opener.open(request, timeout=10) as response:
                        body = response.read(8 * 1024 * 1024 + 1)
                    if len(body) > 8 * 1024 * 1024:
                        raise ValueError('Trace response too large')
                json.loads(body)
            except Exception:
                # Failed/time-out calls remain charged; retries must reserve again.
                body = json.dumps({'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32005, 'message': 'Trace lane unavailable or budget exhausted'}}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()


if __name__ == '__main__':
    serve()
