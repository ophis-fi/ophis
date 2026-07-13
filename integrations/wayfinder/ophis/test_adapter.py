"""Hermetic unit tests for the Ophis Wayfinder adapter.

The full wayfinder-paths SDK (web3/eth-account/privy) is not needed: we stub the two
SDK modules the adapter imports and mock the orderbook REST + the signer. `ophis_core`'s
pure logic (appData, to_atomic, EIP-712 typed data) runs for real against eth-utils.

Run:  uv run --with eth-utils --with pytest python3 -m pytest test_adapter.py -q
"""
from __future__ import annotations

import asyncio
import functools
import logging
import os
import sys
import types

import pytest

# ── Stub the SDK modules the adapter imports (before importing the adapter) ────
def _mod(name: str) -> types.ModuleType:
    m = types.ModuleType(name)
    sys.modules[name] = m
    return m


for _n in (
    "wayfinder_paths",
    "wayfinder_paths.core",
    "wayfinder_paths.core.adapters",
    "wayfinder_paths.core.utils",
):
    _mod(_n)

_ba = _mod("wayfinder_paths.core.adapters.BaseAdapter")


class _BaseAdapter:
    adapter_type = None

    def __init__(self, name, config=None):
        self.name = name
        self.config = config or {}
        self.logger = logging.getLogger(name)

    async def close(self):
        pass


def _require_wallet(fn):
    @functools.wraps(fn)
    async def wrapper(self, *a, **k):
        if not getattr(self, "wallet_address", None):
            return False, "wallet address not configured"
        return await fn(self, *a, **k)

    return wrapper


_ba.BaseAdapter = _BaseAdapter
_ba.require_wallet = _require_wallet

_tok = _mod("wayfinder_paths.core.utils.tokens")


async def _ensure_allowance(**kw):
    return True, {}


async def _get_token_decimals(token, chain_id, **kw):
    return 6


_NATIVE = {"", "native", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "0x0000000000000000000000000000000000000000"}


def _is_native_token(a):
    return a is None or str(a).strip().lower() in _NATIVE


_tok.ensure_allowance = _ensure_allowance
_tok.get_token_decimals = _get_token_decimals
_tok.is_native_token = _is_native_token

# ── Import the adapter (flat) with ophis_core on the path ─────────────────────
sys.path.insert(0, os.path.dirname(__file__))
import ophis_core as oc  # noqa: E402
import adapter as A  # noqa: E402

USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # Base USDC (6 dec)
WETH = "0x4200000000000000000000000000000000000006"
OWNER = "0x1111111111111111111111111111111111111111"
SIG = "0x" + "ab" * 65
UID = "0x" + "cd" * 56


async def _sign_typed_data(_payload):
    return SIG


def _make(chain_id=8453, std=_sign_typed_data):
    return A.OphisAdapter(
        {"chain_id": chain_id},
        sign_callback=lambda tx: None,
        sign_typed_data=std,
        wallet_address=OWNER,
    )


def _patch_orderbook(monkeypatch, *, quote, decimals=6):
    monkeypatch.setattr(oc, "enroll_wallet", lambda w: None)
    monkeypatch.setattr(oc, "get_quote", lambda *a, **k: quote)
    monkeypatch.setattr(oc, "put_app_data", lambda *a, **k: None)
    monkeypatch.setattr(oc, "post_order", lambda *a, **k: UID)

    async def _decimals(*a, **k):
        return decimals

    monkeypatch.setattr(A, "get_token_decimals", _decimals)


def _run(coro):
    return asyncio.run(coro)


_GOOD = {"buyAmount": "50000000000000000", "sellAmount": "100000000", "feeAmount": "0"}


def test_happy_path_submits_and_binds(monkeypatch):
    _patch_orderbook(monkeypatch, quote=dict(_GOOD))
    ok, res = _run(_make().swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="100"))
    assert ok is True
    assert res["order_uid"] == UID
    assert res["sell_amount"] == "100000000"
    # 50bps slippage off 5e16 -> floor
    assert res["min_buy"] == str(50000000000000000 * 9950 // 10000)


def test_accepts_fee_split_when_gross_matches(monkeypatch):
    # A quote that splits a non-zero fee out is fine as long as sellAmount + feeAmount == requested;
    # the adapter signs feeAmount 0 and the gross amount regardless.
    _patch_orderbook(monkeypatch, quote={**_GOOD, "sellAmount": "99999900", "feeAmount": "100"})
    ok, res = _run(_make().swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="100"))
    assert ok is True and res["order_uid"] == UID


def test_rejects_gross_mismatch(monkeypatch):
    # gross (sellAmount + feeAmount) != requested -> refuse (over- or under-pull).
    _patch_orderbook(monkeypatch, quote={**_GOOD, "sellAmount": "999", "feeAmount": "0"})
    ok, res = _run(_make().swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="100"))
    assert ok is False and "!= requested" in res


def test_rejects_missing_quote_field(monkeypatch):
    # A quote that OMITS sellAmount must be refused, not silently defaulted to the request.
    _patch_orderbook(monkeypatch, quote={"buyAmount": "50000000000000000", "feeAmount": "0"})
    ok, res = _run(_make().swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="100"))
    assert ok is False and "missing required field" in res


def test_rejects_zero_buy_floor(monkeypatch):
    # buyAmount 1 with 50bps slippage rounds the floor to 0.
    _patch_orderbook(monkeypatch, quote={**_GOOD, "buyAmount": "1"})
    ok, res = _run(_make().swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="100"))
    assert ok is False and "minimum buy amount is 0" in res


def test_enforces_caller_min_buy_amount(monkeypatch):
    # Honest-looking quote, but the caller's absolute price floor is not met -> refuse.
    _patch_orderbook(monkeypatch, quote=dict(_GOOD))
    floor = 50000000000000000  # higher than the post-slippage min_buy
    ok, res = _run(_make().swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="100", min_buy_amount=floor))
    assert ok is False and "below the caller minimum" in res


def test_rejects_native_token(monkeypatch):
    _patch_orderbook(monkeypatch, quote=dict(_GOOD))
    ok, res = _run(_make().swap_exact_in(sell_token="native", buy_token=WETH, amount_in="1"))
    assert ok is False and "ERC-20 only" in res


def test_requires_sign_typed_data(monkeypatch):
    _patch_orderbook(monkeypatch, quote=dict(_GOOD))
    ok, res = _run(_make(std=None).swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="100"))
    assert ok is False and "sign_typed_data" in res


def test_unsupported_chain_raises():
    with pytest.raises(ValueError):
        _make(chain_id=10)  # Optimism: Ophis chain, not a Wayfinder chain


def test_excess_precision_amount_is_rejected(monkeypatch):
    # 0-decimal token cannot represent 0.5 — must reject, not round to 1 (the parseUnits lesson).
    _patch_orderbook(monkeypatch, quote=dict(_GOOD), decimals=0)
    ok, res = _run(_make().swap_exact_in(sell_token=USDC, buy_token=WETH, amount_in="0.5"))
    assert ok is False and "decimals" in res


def test_appdata_is_deterministic_and_hashes():
    full, h = oc.build_app_data(referral_code="my-code", is_stable_pair=False)
    assert '"appCode":"ophis"' in full and h.startswith("0x") and len(h) == 66
    assert oc.build_app_data(referral_code="my-code")[1] == h  # deterministic
