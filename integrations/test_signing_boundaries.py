"""Offline wire-format and presign regressions.

Run: uv run --with pycryptodome python integrations/test_signing_boundaries.py
"""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
OWNER = "0x1111111111111111111111111111111111111111"
SELL = "0x4200000000000000000000000000000000000006"
BUY = "0x2222222222222222222222222222222222222222"
APP_HASH = "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d"


def load(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SigningBoundaries(unittest.TestCase):
    def test_all_quote_helpers_send_the_full_appdata_preimage(self):
        for name, path in [
            ("bankr", "bankr/ophis/scripts/ophis_common.py"),
            ("metamask", "metamask/ophis/scripts/ophis_common.py"),
            ("swarms", "swarms/ophis/ophis_core.py"),
            ("wayfinder", "wayfinder/ophis/ophis_core.py"),
        ]:
            with self.subTest(integration=name):
                module = load(name, path)
                with patch.object(module, "_http", return_value={"quote": {}}) as http:
                    module.get_quote(8453, SELL, BUY, 1000, OWNER, "{}", APP_HASH)
                    body = http.call_args.kwargs["body"]
                    self.assertEqual(body["appData"], "{}")
                    self.assertEqual(body["appDataHash"], APP_HASH)

    def test_bankr_uid_matches_independent_viem_vectors(self):
        module = load("bankr", "bankr/ophis/scripts/ophis_common.py")
        order = {
            "sellToken": SELL, "buyToken": BUY, "receiver": OWNER, "from": OWNER,
            "sellAmount": "1000", "buyAmount": "1980", "validTo": 1800001200,
            "feeAmount": "0", "kind": "sell", "partiallyFillable": False,
            "sellTokenBalance": "erc20", "buyTokenBalance": "erc20",
            "appData": "{}", "appDataHash": APP_HASH,
        }
        # Independently generated with viem.hashTypedData + @ophis/sdk's domain/types.
        for chain, digest in [
            (10, "0e2a1516078492f6410076dc90aa748c632afde7892a603f22a0658e2909828a"),
            (8453, "93aef93b37e38299e701ccf0583822b522bb90d4d0cdf7a1339643d41cc0c517"),
        ]:
            self.assertEqual(module.compute_order_uid(chain, order), "0x" + digest + OWNER[2:] + "6b49d6b0")
            self.assertNotEqual(module.compute_order_uid(chain, {**order, "receiver": BUY}), module.compute_order_uid(chain, order))

    def test_bankr_never_presigns_an_unrelated_host_uid(self):
        common = load("ophis_common", "bankr/ophis/scripts/ophis_common.py")
        with patch.dict(sys.modules, {"ophis_common": common}):
            swap = load("bankr_swap", "bankr/ophis/scripts/ophis-swap.py")
        with contextlib.ExitStack() as stack:
            for name, value in {
                "bankr_api_key": "test-key", "bankr_wallet_address": OWNER,
                "enroll_wallet": None, "build_app_data": ("{}", APP_HASH),
                "get_quote": {"sellToken": SELL, "buyToken": BUY, "sellAmount": "1000", "feeAmount": "0", "buyAmount": "2000"},
                "put_app_data": None, "read_allowance": 1000,
                "post_order": "0x" + "ff" * 56,
            }.items():
                stack.enter_context(patch.object(common, name, return_value=value))
            submit = stack.enter_context(patch.object(common, "bankr_submit"))
            stack.enter_context(patch.object(sys, "argv", ["ophis-swap.py", "8453", SELL, "0", "1000", BUY, "0", "100"]))
            stack.enter_context(patch.object(swap.time, "time", return_value=1800000000))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            with self.assertRaisesRegex(SystemExit, "refusing to presign"):
                swap.main()
            submit.assert_not_called()
            expected = "0x93aef93b37e38299e701ccf0583822b522bb90d4d0cdf7a1339643d41cc0c517" + OWNER[2:] + "6b49d6b0"
            common.post_order.return_value = expected
            swap.main()
            submit.assert_called_once_with("test-key", 8453, common.settlement_address(8453),
                                           common.encode_set_presignature(expected, True),
                                           "Authorize Ophis/CoW order (setPreSignature)")


if __name__ == "__main__":
    unittest.main()
