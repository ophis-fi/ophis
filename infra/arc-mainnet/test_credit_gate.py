import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from unittest.mock import Mock, patch
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from credit_gate import DRPC, VALIDATIONCLOUD, Budget, cost, serve, validationcloud_cost

# Fixture only: shaped like a real key, never a real one.
VC_URL = 'https://mainnet.arc.validationcloud.io/v1/' + 'k' * 43


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
        minutes = DRPC['day'] // DRPC['minute']
        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(str(Path(directory) / 'credits.sqlite'), 100_000_000)
            self.assertTrue(budget.reserve(DRPC['minute'], 0))
            self.assertFalse(budget.reserve(20, 1))
            for minute in range(1, minutes):
                self.assertTrue(budget.reserve(DRPC['minute'], minute * 60))
            self.assertFalse(budget.reserve(20, minutes * 60))
            self.assertTrue(budget.reserve(20, 86400))

    def test_free_pool_ceiling_and_pacing_survive_restarts(self):
        minutes = DRPC['day'] // DRPC['minute']
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'credits.sqlite')
            budget = Budget(path, 180_000_000)
            for day in range(31):
                for minute in range(minutes):
                    self.assertTrue(budget.reserve(DRPC['minute'], day * 86400 + minute * 60))
                budget = Budget(path, 180_000_000)
                self.assertFalse(budget.reserve(20, day * 86400 + minutes * 60))
            # Even a fully exhausted daily budget uses under 6% of the free pool.
            self.assertLessEqual(31 * DRPC['day'], 210_000_000 * 0.06)
            for allowance in (0, 180_000_001, 210_000_000):
                with self.assertRaises(ValueError):
                    Budget(path, allowance)

    def test_method_boundary(self):
        trace = {'jsonrpc': '2.0', 'method': 'debug_traceTransaction', 'params': ['0x' + '11' * 32, {'tracer': 'callTracer'}]}
        self.assertEqual(cost(trace), 20)
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
            env = {'ARC_CREDIT_DB': path, 'ARC_DRPC_CU_ALLOWANCE': '40'}
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
                self.assertEqual(opener.return_value.open.call_args.args[0].full_url, 'https://arc.drpc.org')
                self.assertEqual(opener.return_value.open.call_args.args[0].get_header('User-agent'), 'ophis-arc-rpc/1.0')
                self.assertFalse(Budget(path, 40).reserve(20, 86400))

    def test_validationcloud_daily_cap_bounds_the_free_month(self):
        self.assertLessEqual(31 * VALIDATIONCLOUD['day'], 50_000_000 * 0.95)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'credits.sqlite')
            budget = Budget(path, None, VALIDATIONCLOUD['minute'], VALIDATIONCLOUD['day'])
            minutes = VALIDATIONCLOUD['day'] // VALIDATIONCLOUD['minute']
            for day in range(31):
                for minute in range(minutes):
                    self.assertTrue(budget.reserve(VALIDATIONCLOUD['minute'], day * 86400 + minute * 60))
                # A restart cannot reset the day, and the minute cap holds too.
                budget = Budget(path, None, VALIDATIONCLOUD['minute'], VALIDATIONCLOUD['day'])
                self.assertFalse(budget.reserve(40, day * 86400 + minutes * 60))
            self.assertFalse(budget.reserve(VALIDATIONCLOUD['minute'] + 40, 31 * 86400))

    def test_validationcloud_method_boundary(self):
        call = [{'to': '0x' + '11' * 20, 'data': '0x12345678'}, 'latest']
        for method, params in [('eth_call', call), ('eth_estimateGas', call), ('eth_gasPrice', []),
                               ('eth_getBlockByNumber', ['latest', False])]:
            self.assertEqual(validationcloud_cost({'jsonrpc': '2.0', 'method': method, 'params': params}), 40)
        for method, params in [('debug_traceTransaction', ['0x' + '11' * 32, {'tracer': 'callTracer'}]),
                               ('eth_sendRawTransaction', ['0x00']), ('eth_getLogs', [{}])]:
            with self.subTest(method=method), self.assertRaises(ValueError):
                validationcloud_cost({'jsonrpc': '2.0', 'method': method, 'params': params})

    def test_validationcloud_lane_url_cap_and_secrecy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'credits.sqlite')
            for bad in ('https://arc.drpc.org', 'http://mainnet.arc.validationcloud.io/v1/' + 'k' * 43,
                        VC_URL + '/../x', 'https://mainnet.arc.validationcloud.io.evil/v1/' + 'k' * 43):
                env = {'ARC_CREDIT_DB': path, 'ARC_GATE_LANE': 'validationcloud', 'ARC_VALIDATIONCLOUD_URL': bad}
                with patch.dict(os.environ, env), patch('credit_gate.ThreadingHTTPServer') as server:
                    with self.assertRaises(ValueError) as error:
                        serve()
                    self.assertNotIn('k' * 20, str(error.exception))
                    server.assert_not_called()
            env = {'ARC_CREDIT_DB': path, 'ARC_GATE_LANE': 'validationcloud', 'ARC_VALIDATIONCLOUD_URL': VC_URL}
            with patch.dict(os.environ, env), patch('credit_gate.ThreadingHTTPServer') as server, patch('credit_gate.urllib.request.build_opener') as opener:
                opener.return_value.open.side_effect = TimeoutError('fixture only; no network')
                serve()
                handler_class = server.call_args.args[1]
                for method, params in [('debug_traceTransaction', ['0x' + 'ab' * 32, {'tracer': 'callTracer'}]),
                                       ('eth_call', [{'to': '0x' + '11' * 20}, 'latest'])]:
                    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
                    handler = object.__new__(handler_class)
                    handler.headers = {'Content-Length': str(len(body))}
                    handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
                    handler.send_response = handler.send_header = handler.end_headers = Mock()
                    handler.do_POST()
                    response = handler.wfile.getvalue().decode()
                    self.assertIn('Validation Cloud lane unavailable', response)
                    self.assertNotIn('k' * 20, response)
                # The trace was refused before any reservation; the failed read stays charged.
                self.assertEqual(opener.return_value.open.call_count, 1)
                self.assertEqual(opener.return_value.open.call_args.args[0].full_url, VC_URL)
                with closing(sqlite3.connect(path)) as db:
                    self.assertEqual(db.execute('SELECT total FROM usage').fetchone(), (40,))


if __name__ == '__main__':
    unittest.main()
