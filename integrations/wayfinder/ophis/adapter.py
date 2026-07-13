"""Ophis (CoW Protocol) swap adapter for Wayfinder Paths.

Ophis routes a same-chain ERC-20 swap as an OFF-CHAIN, EIP-712-signed CoW order:
MEV-protected, gasless at settlement, surplus returned, no sandwiching. This adapter
mirrors the `uniswap_adapter` shape but, because there is no router `execute()` call,
it (1) approves the CoW VaultRelayer with Wayfinder's audited `ensure_allowance` and
(2) signs the GPv2 order with Wayfinder's typed-data callback, then submits it to the
Ophis/CoW orderbook. The Ophis partner fee + referral ride in the order's appData.

Wallet contract (same factories as the rest of the SDK, see core/utils/wallets.py):
  - `sign_callback(tx) -> bytes`      : signs the ERC-20 approval tx (local or remote).
  - `sign_typed_data(payload) -> str` : signs the EIP-712 order. REQUIRED here; the
    Uniswap path never needs typed-data signing, so BaseAdapter callers pass only
    `sign_callback` — an Ophis Path must additionally wire `sign_typed_data`.

Return convention matches the other adapters: `(ok: bool, result_or_error)`.
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any

from eth_utils import to_checksum_address

from wayfinder_paths.core.adapters.BaseAdapter import BaseAdapter, require_wallet
from wayfinder_paths.core.utils.tokens import (
    ensure_allowance,
    get_token_decimals,
    is_native_token,
)

try:
    from . import ophis_core as oc
except ImportError:  # loaded flat (e.g. bundled loose in a Path) rather than as a package
    import ophis_core as oc  # type: ignore[no-redef]

MAX_SLIPPAGE_BPS = 5_000  # 50%. At 100% the buy floor is 0 (an accept-any-price order).
ORDER_TTL_SECONDS = 1_200  # order valid ~20 min; we set this ourselves, never the quote.


class OphisAdapter(BaseAdapter):
    adapter_type = "OPHIS"

    def __init__(
        self,
        config: dict[str, Any],
        *,
        sign_callback=None,
        sign_typed_data=None,
        wallet_address: str | None = None,
    ) -> None:
        super().__init__("ophis_adapter", config)
        chain_id = int(config.get("chain_id", 8453))
        if chain_id not in oc.SUPPORTED_CHAIN_IDS:
            raise ValueError(
                f"Unsupported chain_id {chain_id} for Ophis. "
                f"Supported: {sorted(oc.SUPPORTED_CHAIN_IDS)}"
            )
        if not wallet_address:
            raise ValueError("wallet_address is required for OphisAdapter")
        self.chain_id = chain_id
        self.owner = to_checksum_address(str(wallet_address))
        self.wallet_address = self.owner  # gates @require_wallet
        self.sign_callback = sign_callback
        self.sign_typed_data = sign_typed_data

    @require_wallet
    async def swap_exact_in(
        self,
        *,
        sell_token: str,
        buy_token: str,
        amount_in: str,
        slippage_bps: int = 50,
        referral_code: str | None = None,
        is_stable_pair: bool = False,
        min_buy_amount: int | str | None = None,
    ) -> tuple[bool, Any]:
        """MEV-protected exact-in swap of `amount_in` (whole units) of `sell_token`
        for `buy_token` on this adapter's chain. Returns (True, {order_uid, ...}) on
        submission, or (False, reason).

        `min_buy_amount` (base units of buy_token, optional) is an ABSOLUTE price floor:
        the order's post-slippage buy minimum must be >= it, else the swap is refused.
        Supply it to bind price against an adversarial quote — the orderbook is otherwise
        trusted for pricing (as in every CoW integration). `is_stable_pair` is caller-
        declared (it selects the 1bp stable-fee tier); the caller owns that classification.
        """
        try:
            if self.sign_typed_data is None:
                return False, "sign_typed_data callback is required to sign Ophis (CoW) EIP-712 orders"
            if is_native_token(sell_token) or is_native_token(buy_token):
                return False, "Ophis EOA orders are ERC-20 only; wrap native to WETH first (native uses CoW eth-flow)."
            if not (0 <= slippage_bps <= MAX_SLIPPAGE_BPS):
                return False, f"slippage_bps must be within [0, {MAX_SLIPPAGE_BPS}] (0%..50%)"

            sell = to_checksum_address(str(sell_token))
            buy = to_checksum_address(str(buy_token))

            # ALWAYS read decimals on-chain — never accept a caller-supplied decimals value.
            # A wrong (larger) decimals would inflate the atomic sell amount and the request
            # itself, so the quote's echoed sellAmount could not detect the over-sell.
            sell_decimals = await get_token_decimals(sell, self.chain_id)
            sell_atomic = oc.to_atomic(amount_in, int(sell_decimals))

            await asyncio.to_thread(oc.enroll_wallet, self.owner)  # best-effort; never raises

            # 1-2. Ophis partner-fee appData + a quote (quote carries the appData HASH).
            full_app_data, app_hash = oc.build_app_data(referral_code=referral_code, is_stable_pair=is_stable_pair)
            quote = await asyncio.to_thread(oc.get_quote, self.chain_id, sell, buy, sell_atomic, self.owner, app_hash)
            if not isinstance(quote, dict):
                return False, f"orderbook quote was not an object: {quote!r}"
            # Require the binding fields to be PRESENT — a missing field must not silently
            # default into the request (which would defeat the bind below).
            for field in ("sellAmount", "buyAmount", "feeAmount"):
                if field not in quote:
                    return False, f"orderbook quote is missing required field {field!r}: {quote}"
            quote_buy = int(quote["buyAmount"])
            quote_sell = int(quote["sellAmount"])
            quote_fee = int(quote["feeAmount"])

            # Bind the SIGNED order to the request — never sign fields drifted from intent.
            # Ophis orders carry feeAmount 0 (the fee is in appData); a non-zero quote fee is
            # extra sell-token spend the slippage bound does not cover. A quote sellAmount that
            # differs from the request would sign a different sell size than asked.
            if quote_fee != 0:
                return False, f"orderbook returned a non-zero feeAmount ({quote_fee}); Ophis orders must have feeAmount 0"
            if quote_sell != sell_atomic:
                return False, f"orderbook sellAmount ({quote_sell}) != requested ({sell_atomic}); refusing to sign a different amount"
            if quote_buy <= 0:
                return False, f"quote returned no buyAmount: {quote}"

            min_buy = quote_buy * (10_000 - slippage_bps) // 10_000
            if min_buy <= 0:
                return False, "computed minimum buy amount is 0 — refusing an accept-any-price order"
            if min_buy_amount is not None and min_buy < int(min_buy_amount):
                return False, (
                    f"order buy floor {min_buy} is below the caller minimum {int(min_buy_amount)}; "
                    "refusing (quote price below the supplied limit)"
                )

            valid_to = int(time.time()) + ORDER_TTL_SECONDS  # self-set, not the quote's expiry

            # 3. Publish the full appData so solvers honor the partner fee for this hash.
            await asyncio.to_thread(oc.put_app_data, self.chain_id, app_hash, full_app_data)

            # 4. Approve the CoW VaultRelayer (audited helper: allowance-aware + USDT reset).
            ok, approve_res = await ensure_allowance(
                token_address=sell,
                owner=self.owner,
                spender=oc.CANONICAL_VAULT_RELAYER,
                amount=sell_atomic,
                chain_id=self.chain_id,
                signing_callback=self.sign_callback,
            )
            if ok is False:
                return False, f"VaultRelayer approval failed: {approve_res}"

            # 5. EIP-712-sign the GPv2 order (signed order carries appData = the bytes32 hash).
            signed_message = {
                "sellToken": sell,
                "buyToken": buy,
                "receiver": self.owner,  # receiver pinned to owner (drain guard)
                "sellAmount": str(sell_atomic),
                "buyAmount": str(min_buy),
                "validTo": valid_to,
                "appData": app_hash,
                "feeAmount": "0",
                "kind": "sell",
                "partiallyFillable": False,
                "sellTokenBalance": "erc20",
                "buyTokenBalance": "erc20",
            }
            typed_data = oc.build_order_typed_data(self.chain_id, signed_message)
            signature = await self.sign_typed_data(typed_data)
            # An EOA EIP-712 signature is exactly 65 bytes = 130 hex chars. Enforce the exact
            # length so a truncated/oversized value can't slip through to the orderbook.
            if not (isinstance(signature, str) and re.fullmatch(r"0x[a-fA-F0-9]{130}", signature)):
                return False, f"typed-data callback returned a malformed 65-byte signature: {signature!r}"

            # 6. Submit: appData on the wire is the FULL json string (+ appDataHash).
            order_body = {
                **signed_message,
                "appData": full_app_data,
                "appDataHash": app_hash,
                "signingScheme": "eip712",
                "signature": signature,
                "from": self.owner,
            }
            order_uid = await asyncio.to_thread(oc.post_order, self.chain_id, order_body)

            base = oc.orderbook_url(self.chain_id)
            return True, {
                "order_uid": order_uid,
                "sell_token": sell,
                "buy_token": buy,
                "sell_amount": str(sell_atomic),
                "expected_buy": str(quote_buy),
                "min_buy": str(min_buy),
                "status_url": f"{base}/api/v1/orders/{order_uid}",
                "explorer_url": f"https://explorer.ophis.fi/orders/{order_uid}",
            }
        except Exception as exc:  # noqa: BLE001 — adapter contract: return (False, reason), never raise.
            # asyncio.CancelledError is a BaseException (not Exception) on 3.8+, so cooperative
            # cancellation still propagates; every ordinary failure (RPC, signer, malformed
            # response) becomes a clean (False, reason) instead of escaping the (ok, result) API.
            self.logger.warning(f"Ophis swap failed: {exc}")
            return False, str(exc)
