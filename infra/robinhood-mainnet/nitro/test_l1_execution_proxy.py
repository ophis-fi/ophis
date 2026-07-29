import importlib.util
from pathlib import Path
from unittest import TestCase, main, mock

MODULE_PATH = Path(__file__).with_name("l1-execution-proxy.py")
SPEC = importlib.util.spec_from_file_location("l1_execution_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class L1ExecutionProxyTest(TestCase):
    def test_splits_log_ranges_at_free_limit(self) -> None:
        request = {
            "jsonrpc": "2.0",
            "method": "eth_getLogs",
            "params": [{"fromBlock": "0x1", "toBlock": "0x33"}],
            "id": 1,
        }
        with mock.patch.object(
            proxy,
            "_rate_limited_fallback_request",
            side_effect=[{"result": [{"logIndex": "0x0"}]}, {"result": []}],
        ) as fallback:
            self.assertEqual(proxy.dispatch(request)["result"], [{"logIndex": "0x0"}])
            self.assertEqual(fallback.call_count, 2)

    def test_general_requests_use_drpc(self) -> None:
        request = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
        with mock.patch.object(proxy, "_post", return_value={"jsonrpc": "2.0", "id": 1, "result": "0x1"}) as post:
            self.assertEqual(proxy.dispatch(request)["result"], "0x1")
            post.assert_called_once_with(proxy.GENERAL_UPSTREAM, request)

    def test_logs_use_serialized_fallback(self) -> None:
        request = {
            "jsonrpc": "2.0",
            "method": "eth_getLogs",
            "params": [{"fromBlock": "0x1", "toBlock": "0x32"}],
            "id": 1,
        }
        with mock.patch.object(
            proxy, "_rate_limited_fallback_request", return_value={"result": []}
        ) as fallback:
            self.assertEqual(
                proxy.dispatch(request), {"jsonrpc": "2.0", "id": 1, "result": []}
            )
            fallback.assert_called_once()


if __name__ == "__main__":
    main()
