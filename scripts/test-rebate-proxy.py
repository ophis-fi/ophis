#!/usr/bin/env python3
"""Exercise the production forwarding policy: CADDY_BIN=/path/to/caddy python3 scripts/test-rebate-proxy.py."""
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]


class Headers(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(dict(self.headers)).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def check_forwarding(caddy, source, backend, trusted):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    config = source.replace('{', '{\n    admin off\n    auto_https off', 1)
    config = config.replace(':80 {', f'http://127.0.0.1:{port} {{')
    config = config.replace('indexer:8080', f'127.0.0.1:{backend.server_port}')
    if not trusted:
        # The same policy with loopback outside the trusted hop list.
        config = config.replace('127.0.0.0/8 ::1/128 172.16.0.0/12', '192.0.2.0/24')
    with tempfile.TemporaryDirectory(prefix='ophis-proxy-test-') as directory:
        path = Path(directory) / 'Caddyfile'
        path.write_text(config)
        with (Path(directory) / 'caddy.log').open('w+') as log:
            process = subprocess.Popen([caddy, 'run', '--config', str(path), '--adapter', 'caddyfile'],
                                       stdout=log, stderr=log)
            try:
                url = f'http://127.0.0.1:{port}/'
                for _attempt in range(100):
                    if process.poll() is not None:
                        log.seek(0)
                        raise AssertionError(log.read())
                    try:
                        urllib.request.urlopen(url, timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise AssertionError('Caddy did not become ready')
                for visitor in ['198.51.100.10', '203.0.113.20']:
                    request = urllib.request.Request(url, headers={
                        'CF-Connecting-IP': visitor,
                        'X-Forwarded-For': '192.0.2.99',
                        'X-Real-IP': '192.0.2.99',
                    })
                    with urllib.request.urlopen(request, timeout=3) as response:
                        headers = json.load(response)
                    expected = visitor if trusted else '127.0.0.1'
                    assert headers['X-Forwarded-For'] == expected, headers
                    assert headers['X-Real-Ip'] == expected, headers
                with urllib.request.urlopen(urllib.request.Request(
                    url, headers={'X-Forwarded-For': '192.0.2.99'}), timeout=3,
                ) as response:
                    assert json.load(response)['X-Forwarded-For'] == '127.0.0.1'
            finally:
                process.terminate()
                process.wait(timeout=5)


def main():
    caddy = os.environ.get('CADDY_BIN') or shutil.which('caddy')
    if not caddy:
        raise SystemExit('CADDY_BIN must point to the pinned production Caddy binary')
    compose = (ROOT / 'apps/rebate-indexer/docker-compose.yml').read_text()
    assert '"127.0.0.1:80:80"' in compose and '"80:80"' not in compose
    source = (ROOT / 'apps/rebate-indexer/Caddyfile').read_text()
    backend = http.server.HTTPServer(('127.0.0.1', 0), Headers)
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()
    try:
        check_forwarding(caddy, source, backend, trusted=True)
        check_forwarding(caddy, source, backend, trusted=False)
    finally:
        backend.shutdown()
        backend.server_close()
        thread.join(timeout=5)
    print('Proxy checks passed: distinct visitors, spoofed forwarding headers, untrusted peers, loopback ingress')


if __name__ == '__main__':
    main()
