#!/usr/bin/env python3
"""Local test counter. The only upstream is this lab's disposable Anvil."""
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Lock
from urllib.request import Request, urlopen

counts = Counter()
lock = Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != '/counts':
            self.reply(404, b'{}')
            return
        with lock:
            body = json.dumps(counts).encode()
        self.reply(200, body)

    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8 * 1024 * 1024:
                self.reply(413, b'{}')
                return
            body = self.rfile.read(size)
            payload = json.loads(body)
            requests = payload if isinstance(payload, list) else [payload]
            methods = [item['method'] for item in requests]
            assert all(isinstance(method, str) for method in methods)
            with lock:
                counts.update(methods)  # Batch elements each consume a request.
            request = Request('http://127.0.0.1:8547', data=body,
                              headers={'Content-Type': 'application/json'})
            with urlopen(request, timeout=30) as response:
                self.reply(response.status, response.read())
        except (ValueError, KeyError, TypeError, AssertionError):
            self.reply(400, b'{"error":"invalid RPC request"}')
        except OSError:
            self.reply(502, b'{"error":"local Anvil unavailable"}')


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8548), Handler).serve_forever()
