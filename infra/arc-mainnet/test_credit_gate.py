import io
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from credit_gate import Budget, cost, serve


class CreditGateTest(unittest.TestCase):
    def test_restart_concurrency_and_lifetime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'credits.sqlite')
            budget = Budget(path, 100)
            with ThreadPoolExecutor(max_workers=4) as pool:
                self.assertEqual(sum(pool.map(lambda _: budget.reserve(40, 1), range(4))), 2)
            self.assertFalse(Budget(path, 100).reserve(40, 86400))
            self.assertTrue(Budget(path, 100).reserve(20, 86400))
            self.assertFalse(Budget(path, 100).reserve(1, 200000))

    def test_minute_and_day(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(str(Path(directory) / 'credits.sqlite'), 100000)
            self.assertTrue(budget.reserve(1000, 0))
            self.assertFalse(budget.reserve(20, 1))
            for minute in range(1, 40):
                self.assertTrue(budget.reserve(1000, minute * 60))
            self.assertFalse(budget.reserve(20, 2400))
            self.assertTrue(budget.reserve(20, 86400))

    def test_method_boundary(self):
        trace = {'jsonrpc': '2.0', 'method': 'debug_traceTransaction', 'params': ['0x' + '11' * 32, {'tracer': 'callTracer'}]}
        self.assertEqual(cost(trace), 40)
        self.assertEqual(cost({'jsonrpc': '2.0', 'method': 'eth_chainId'}), 20)
        for payload in ([trace], {**trace, 'method': 'debug_traceBlockByNumber'}, {**trace, 'params': ['0x1', {}]},
                        {'jsonrpc': '2.0', 'method': 'eth_sendRawTransaction', 'params': ['0x00']}):
            with self.assertRaises(ValueError):
                cost(payload)

    def test_quote_reads_and_overrides(self):
        address = '0x' + '11' * 20
        call = {'to': address, 'data': '0x12345678'}
        overrides = {address: {'code': '0x00', 'balance': '0x100'}}
        reads = [('eth_gasPrice', []), ('eth_estimateGas', [call])]
        blocks = ('latest', 'pending', '0x80', {'blockNumber': '0x80'},
                  {'blockHash': '0x' + 'ab' * 32, 'requireCanonical': True})
        for method in ('eth_getBalance', 'eth_getCode'):
            reads.extend((method, [address, block]) for block in blocks)
        for method in ('eth_call', 'eth_estimateGas'):
            reads.extend((method, [call, block, overrides]) for block in blocks)
        for method, params in reads:
            with self.subTest(method=method, params=params):
                self.assertEqual(cost({'jsonrpc': '2.0', 'method': method, 'params': params}), 20)
        for method, params in [('eth_call', {}), ('eth_call', [call, 'latest', []]),
                               ('eth_call', [call, 'latest', {}, {}]),
                               ('eth_call', ['signed-data', 'latest']),
                               ('eth_call', [call, {'blockHash': '0x123'}]),
                               ('eth_call', [call, {'blockHash': '0x' + 'ab' * 32, 'requireCanonical': 1}]),
                               ('eth_call', [call, {'blockNumber': '0x80', 'blockHash': '0x' + 'ab' * 32}]),
                               ('eth_getBalance', ['0x1', 'latest']),
                               ('eth_getBalance', [address, {}]), ('eth_gasPrice', [1]),
                               ('eth_sendTransaction', [call]), ('eth_sign', [address, '0x00']),
                               ('debug_traceCall', [call, 'latest', {}]), ('eth_getLogs', [{}])]:
            with self.subTest(method=method, params=params), self.assertRaises(ValueError):
                cost({'jsonrpc': '2.0', 'method': method, 'params': params})

    def test_http_failures_charge_shared_read_trace_allowance(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'credits.sqlite')
            env = {'ARC_QUICKNODE_RPC_URL': 'https://fixture.arc-mainnet.quiknode.pro/redacted',
                   'ARC_CREDIT_DB': path, 'ARC_QUICKNODE_CREDIT_ALLOWANCE': '60'}
            with patch.dict(os.environ, env), patch('credit_gate.ThreadingHTTPServer') as server, patch('credit_gate.urllib.request.build_opener') as opener:
                opener.return_value.open.side_effect = TimeoutError('fixture only; no network')
                serve()
                handler_class = server.call_args.args[1]
                for method, params in [('eth_sendRawTransaction', ['0x00']),
                                       ('eth_call', [{'to': '0x' + '11' * 20}, 'latest']),
                                       ('debug_traceTransaction', ['0x' + 'ab' * 32, {'tracer': 'callTracer'}]),
                                       ('eth_gasPrice', [])]:
                    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
                    handler = object.__new__(handler_class)
                    handler.headers = {'Content-Length': str(len(body))}
                    handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
                    handler.send_response = handler.send_header = handler.end_headers = Mock()
                    handler.do_POST()
                    self.assertIn('error', json.loads(handler.wfile.getvalue()))
                self.assertEqual(opener.return_value.open.call_count, 2)
                self.assertFalse(Budget(path, 60).reserve(20, 86400))


if __name__ == '__main__':
    unittest.main()
