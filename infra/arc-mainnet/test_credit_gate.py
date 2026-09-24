import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from credit_gate import Budget, cost


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


if __name__ == '__main__':
    unittest.main()
