import importlib.util
import io
import json
import urllib.error
from pathlib import Path
from unittest import TestCase, main, mock

MODULE_PATH = Path(__file__).with_name("l1-execution-proxy.py")
SPEC = importlib.util.spec_from_file_location("l1_execution_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class L1ExecutionProxyTest(TestCase):
    def setUp(self) -> None:
        primary = mock.patch.object(proxy, "PRIMARY_UPSTREAM", "")
        primary.start()
        self.addCleanup(primary.stop)

    def test_post_rejects_wrong_response_identity_and_invalid_envelopes(self) -> None:
        request = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
        valid = {"jsonrpc": "2.0", "id": 1, "result": "0x1"}
        invalid = [[], {}, {**valid, "id": 2}, {**valid, "id": True},
                   {**valid, "jsonrpc": "1.0"}, {"jsonrpc": "2.0", "result": "0x1"},
                   {"jsonrpc": "2.0", "id": 1}, {**valid, "error": {}},
                   {"jsonrpc": "2.0", "id": 1, "error": {"code": "-32005"}}]
        for result in invalid:
            with self.subTest(result=result), mock.patch.object(
                proxy.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(result).encode())
            ), self.assertRaises(ValueError):
                proxy._post(proxy.GENERAL_UPSTREAM, request)
        for result in [valid, {**valid, "result": None},
                       {"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": "rate limit"}}]:
            with mock.patch.object(proxy.urllib.request, "urlopen",
                                   return_value=io.BytesIO(json.dumps(result).encode())):
                self.assertEqual(proxy._post(proxy.GENERAL_UPSTREAM, request), result)

    def test_post_bounds_response_before_decoding(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b" " * (proxy.MAX_RESPONSE_BYTES + 1)
        with mock.patch.object(proxy.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                proxy._post(proxy.GENERAL_UPSTREAM, {"id": 1})
        response.read.assert_called_once_with(proxy.MAX_RESPONSE_BYTES + 1)

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

    def test_dispatches_json_rpc_batch_in_order(self) -> None:
        requests = [
            {"jsonrpc": "2.0", "method": "eth_chainId", "params": [], "id": 1},
            {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 2},
        ]
        with mock.patch.object(
            proxy,
            "dispatch",
            side_effect=[
                {"jsonrpc": "2.0", "id": 1, "result": "0x1"},
                {"jsonrpc": "2.0", "id": 2, "result": "0x2"},
            ],
        ):
            self.assertEqual(
                proxy.dispatch_payload(requests),
                [
                    {"jsonrpc": "2.0", "id": 1, "result": "0x1"},
                    {"jsonrpc": "2.0", "id": 2, "result": "0x2"},
                ],
            )

    def test_general_network_failure_uses_fallback(self) -> None:
        request = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
        with (
            mock.patch.object(
                proxy,
                "_post",
                side_effect=urllib.error.URLError("upstream unavailable"),
            ),
            mock.patch.object(
                proxy,
                "_rate_limited_fallback_request",
                return_value={"jsonrpc": "2.0", "id": 1, "result": "0x1"},
            ) as fallback,
        ):
            self.assertEqual(proxy.dispatch(request)["result"], "0x1")
            fallback.assert_called_once_with(request)

    def test_no_backoff_after_final_failed_attempt(self) -> None:
        request = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
        with (
            mock.patch.object(proxy, "_post", return_value={"error": {"code": -32005}}),
            mock.patch.object(proxy.time, "sleep") as sleep,
            mock.patch.object(proxy.time, "monotonic", return_value=10.0),
        ):
            with self.assertRaisesRegex(RuntimeError, "remained unavailable"):
                proxy._rate_limited_fallback_request(request)
            self.assertNotIn(mock.call(4), sleep.call_args_list)
            self.assertIn(mock.call(1), sleep.call_args_list)
            self.assertIn(mock.call(2), sleep.call_args_list)


class PrimaryFailoverTest(TestCase):
    """The self-hosted lane: serve from it when it answers, fall back when it does not."""

    def setUp(self) -> None:
        self._saved = proxy.PRIMARY_UPSTREAM
        proxy.PRIMARY_UPSTREAM = "http://primary.invalid:8547"

    def tearDown(self) -> None:
        proxy.PRIMARY_UPSTREAM = self._saved

    def test_primary_result_is_served_without_touching_the_fallback(self) -> None:
        request = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
        ok = {"jsonrpc": "2.0", "id": 1, "result": "0x18d1af5"}
        with (
            mock.patch.object(proxy, "_post", return_value=ok) as post,
            mock.patch.object(proxy, "_rate_limited_fallback_request") as fallback,
        ):
            self.assertEqual(proxy.dispatch(request), ok)
            post.assert_called_once_with(
                proxy.PRIMARY_UPSTREAM, request, timeout=proxy.PRIMARY_TIMEOUT
            )
            fallback.assert_not_called()

    def test_getlogs_from_primary_is_not_chunked(self) -> None:
        # The whole point: one request instead of 200 throttled 50-block windows.
        request = {
            "jsonrpc": "2.0",
            "method": "eth_getLogs",
            "params": [{"fromBlock": "0x1", "toBlock": "0x2710"}],
            "id": 1,
        }
        ok = {"jsonrpc": "2.0", "id": 1, "result": [{"logIndex": "0x0"}]}
        with (
            mock.patch.object(proxy, "_post", return_value=ok) as post,
            mock.patch.object(proxy, "_rate_limited_fallback_request") as fallback,
        ):
            self.assertEqual(proxy.dispatch(request), ok)
            self.assertEqual(post.call_count, 1)
            fallback.assert_not_called()

    def test_primary_transport_failure_falls_back(self) -> None:
        request = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
        with (
            mock.patch.object(proxy, "_post", side_effect=OSError("connection refused")),
            mock.patch.object(
                proxy,
                "_rate_limited_fallback_request",
                return_value={"jsonrpc": "2.0", "id": 1, "result": "0x1"},
            ) as fallback,
        ):
            self.assertEqual(proxy.dispatch(request)["result"], "0x1")
            fallback.assert_called_once_with(request)

    def test_primary_jsonrpc_error_falls_back(self) -> None:
        # e.g. the self-hosted node's own 20,000-result cap on eth_getLogs, which
        # the fallback's 50-block chunking handles.
        # one 50-block chunk, so the fallback is expected exactly once
        request = {
            "jsonrpc": "2.0",
            "method": "eth_getLogs",
            "params": [{"fromBlock": "0x1", "toBlock": "0x10"}],
            "id": 1,
        }
        with (
            mock.patch.object(
                proxy,
                "_post",
                return_value={"error": {"code": -32602, "message": "query exceeds max results"}},
            ),
            mock.patch.object(
                proxy,
                "_rate_limited_fallback_request",
                return_value={"result": [{"logIndex": "0x0"}]},
            ) as fallback,
        ):
            self.assertEqual(proxy.dispatch(request)["result"], [{"logIndex": "0x0"}])
            self.assertEqual(fallback.call_count, 1)

    def test_unset_primary_preserves_the_old_public_only_behaviour(self) -> None:
        proxy.PRIMARY_UPSTREAM = ""
        request = {"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
        with mock.patch.object(
            proxy, "_post", return_value={"jsonrpc": "2.0", "id": 1, "result": "0x1"}
        ) as post:
            self.assertEqual(proxy.dispatch(request)["result"], "0x1")
            post.assert_called_once_with(proxy.GENERAL_UPSTREAM, request)

    def test_excessive_log_range_never_reaches_either_provider(self) -> None:
        request = {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                   "params": [{"fromBlock": "0x1", "toBlock": "0x2711"}]}
        with mock.patch.object(proxy, "_post") as post:
            with self.assertRaisesRegex(ValueError, "excessive"):
                proxy.dispatch(request)
            post.assert_not_called()

    def test_malformed_primary_response_falls_back_over_the_real_parser(self) -> None:
        request = {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}
        ok = {"jsonrpc": "2.0", "id": 1, "result": "0x123"}
        for bad in ([], {}, {**ok, "id": 2}, {**ok, "id": True},
                    {**ok, "error": {"code": -32005, "message": "rate limit"}}):
            with self.subTest(response=bad), mock.patch.object(
                proxy.urllib.request, "urlopen",
                side_effect=[io.BytesIO(json.dumps(bad).encode()),
                             io.BytesIO(json.dumps(ok).encode())],
            ) as open_url:
                self.assertEqual(proxy.dispatch(request), ok)
                self.assertEqual(open_url.call_count, 2)

    def test_response_size_is_bounded(self) -> None:
        request = {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}
        with (mock.patch.object(proxy, "MAX_RESPONSE_BYTES", 8),
              mock.patch.object(proxy.urllib.request, "urlopen", return_value=io.BytesIO(b"x" * 9))):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                proxy._post(proxy.PRIMARY_UPSTREAM, request)


if __name__ == "__main__":
    main()
