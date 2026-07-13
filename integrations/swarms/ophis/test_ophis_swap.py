"""Hermetic tests for the Ophis Swarms tool.

Real eth_account signing runs (offline) against a throwaway test key; only the orderbook
REST + JSON-RPC are mocked. Run:
  uv run --with eth-account --with "eth-hash[pycryptodome]" --with pytest python3 -m pytest test_ophis_swap.py -q
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import ophis_core as oc  # noqa: E402
import ophis_swap as t  # noqa: E402

# Hardhat account #0 — a well-known throwaway key, never funded on mainnet.
TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # Base USDC (6 dec)
WETH = "0x4200000000000000000000000000000000000006"
UID = "0x" + "cd" * 56
GOOD = {
    "sellToken": USDC, "buyToken": WETH,
    "buyAmount": "50000000000000000", "sellAmount": "100000000", "feeAmount": "0",
}


def _base(monkeypatch, *, quote=None, decimals=6, allowance=10**30):
    monkeypatch.setenv("OPHIS_PRIVATE_KEY", TEST_KEY)
    for var in ("PRIVATE_KEY", "TRANSMITTER_PRIVATE_KEY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(oc, "read_decimals", lambda c, tok: decimals)
    monkeypatch.setattr(oc, "enroll_wallet", lambda w: None)
    monkeypatch.setattr(oc, "get_quote", lambda *a, **k: (quote if quote is not None else dict(GOOD)))
    monkeypatch.setattr(oc, "put_app_data", lambda *a, **k: None)
    monkeypatch.setattr(oc, "post_order", lambda *a, **k: UID)
    monkeypatch.setattr(oc, "read_allowance", lambda *a, **k: allowance)


def test_happy_path_allowance_sufficient(monkeypatch):
    _base(monkeypatch)
    res = json.loads(t.ophis_swap(USDC, WETH, "100", chain="base"))
    assert res["ok"] is True
    assert res["order_uid"] == UID
    assert res["sell_amount"] == "100000000"
    assert res["min_buy"] == str(50000000000000000 * 9950 // 10000)


def test_happy_path_with_approve_and_receipt(monkeypatch):
    _base(monkeypatch, allowance=0)  # forces an approve
    sent = {}
    monkeypatch.setattr(oc, "get_nonce", lambda c, o: 7)
    monkeypatch.setattr(oc, "get_gas_price", lambda c: 10**9)
    monkeypatch.setattr(oc, "estimate_gas", lambda c, tx: 46_000)
    monkeypatch.setattr(oc, "send_raw_transaction", lambda c, raw: sent.setdefault("raw", raw) or ("0x" + "ab" * 32))
    monkeypatch.setattr(oc, "get_transaction_receipt", lambda c, h: {"blockNumber": "0x1", "status": "0x1"})
    res = json.loads(t.ophis_swap(USDC, WETH, "100", chain="base"))
    assert res["ok"] is True and res["order_uid"] == UID
    assert sent["raw"].startswith("0x")  # a real signed raw tx was broadcast


def test_approve_revert_aborts(monkeypatch):
    _base(monkeypatch, allowance=0)
    monkeypatch.setattr(oc, "get_nonce", lambda c, o: 0)
    monkeypatch.setattr(oc, "get_gas_price", lambda c: 10**9)
    monkeypatch.setattr(oc, "estimate_gas", lambda c, tx: 46_000)
    monkeypatch.setattr(oc, "send_raw_transaction", lambda c, raw: "0x" + "ab" * 32)
    monkeypatch.setattr(oc, "get_transaction_receipt", lambda c, h: {"blockNumber": "0x1", "status": "0x0"})  # reverted
    res = json.loads(t.ophis_swap(USDC, WETH, "100", chain="base"))
    assert res["ok"] is False and "reverted" in res["error"]


def test_accepts_fee_split_when_gross_matches(monkeypatch):
    # A non-zero fee split out is fine as long as sellAmount + feeAmount == requested; the tool
    # signs feeAmount 0 and the gross amount regardless.
    _base(monkeypatch, quote={**GOOD, "sellAmount": "99999900", "feeAmount": "100"})
    res = json.loads(t.ophis_swap(USDC, WETH, "100"))
    assert res["ok"] is True and res["order_uid"] == UID


def test_rejects_gross_mismatch(monkeypatch):
    _base(monkeypatch, quote={**GOOD, "sellAmount": "999"})
    res = json.loads(t.ophis_swap(USDC, WETH, "100"))
    assert res["ok"] is False and "!= requested" in res["error"]


def test_rejects_missing_field(monkeypatch):
    _base(monkeypatch, quote={"buyAmount": "5", "feeAmount": "0"})  # no sellAmount/tokens
    res = json.loads(t.ophis_swap(USDC, WETH, "100"))
    assert res["ok"] is False and "missing required field" in res["error"]


def test_rejects_token_substitution(monkeypatch):
    # Quote echoes a DIFFERENT sell token than requested -> refuse (defense in depth).
    _base(monkeypatch, quote={**GOOD, "sellToken": WETH})
    res = json.loads(t.ophis_swap(USDC, WETH, "100"))
    assert res["ok"] is False and "sellToken" in res["error"] and "refusing" in res["error"]


def test_rejects_zero_buy_floor(monkeypatch):
    _base(monkeypatch, quote={**GOOD, "buyAmount": "1"})
    res = json.loads(t.ophis_swap(USDC, WETH, "100"))
    assert res["ok"] is False and "minimum buy amount is 0" in res["error"]


def test_missing_key(monkeypatch):
    _base(monkeypatch)
    monkeypatch.delenv("OPHIS_PRIVATE_KEY", raising=False)
    res = json.loads(t.ophis_swap(USDC, WETH, "100"))
    assert res["ok"] is False and "no signer key" in res["error"]


def test_rejects_native(monkeypatch):
    _base(monkeypatch)
    res = json.loads(t.ophis_swap("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", WETH, "1"))
    assert res["ok"] is False and "ERC-20 only" in res["error"]


def test_unsupported_chain(monkeypatch):
    _base(monkeypatch)
    res = json.loads(t.ophis_swap(USDC, WETH, "100", chain="solana"))
    assert res["ok"] is False and "unsupported chain" in res["error"]


def test_excess_precision(monkeypatch):
    _base(monkeypatch, decimals=0)
    res = json.loads(t.ophis_swap(USDC, WETH, "0.5"))
    assert res["ok"] is False and "decimals" in res["error"]


def test_appdata_deterministic():
    full, h = oc.build_app_data(referral_code="my-code")
    assert '"appCode":"ophis"' in full and h.startswith("0x") and len(h) == 66
    assert oc.build_app_data(referral_code="my-code")[1] == h


def test_sovereign_chains_use_noncanonical_settlement():
    # OP/Unichain use their non-canonical Settlement as the EIP-712 verifyingContract.
    assert oc.settlement_address(10) == "0x310784c7FCE12d578dA6f53460777bAc9718B859"
    assert oc.settlement_address(8453) == "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"
    assert oc.vault_relayer(130) == "0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb"
