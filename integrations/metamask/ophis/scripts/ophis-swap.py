#!/usr/bin/env python3
"""Ophis (CoW Protocol) MEV-protected SAME-CHAIN swap, executed with the MetaMask
Agent Wallet (`mm`).

Usage:
  ophis-swap.py <chain_id> <sell_token> <sell_decimals> <amount> <buy_token> <buy_decimals> [slippage_bps] [referral_code]

Example (100 USDC -> WETH on Base, 0.5% slippage):
  ophis-swap.py 8453 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 6 100 \\
                0x4200000000000000000000000000000000000006 18 50

Flow (a CoW swap is an off-chain EIP-712-signed order — the MetaMask wallet signs it
directly, no presign):
  1. quote      POST {orderbook}/api/v1/quote   (appData = hash)
  2. appData    build Ophis partner-fee appData + hash
  3. put        PUT  {orderbook}/api/v1/app_data/{hash}
  4. approve    `mm wallet send-transaction`  approve(VaultRelayer, ...)   [on-chain]
  5. sign       `mm wallet sign-typed-data`   EIP-712 GPv2 order -> signature
  6. submit     POST {orderbook}/api/v1/orders  signingScheme=eip712 -> order UID

Options: [slippage_bps] default 50 (0.5%, capped 5000). [referral_code] earns the
rebate. The 1bp stable-pair tier is applied automatically when both tokens are in the
verified stablecoin registry (never a caller flag).

Requires: the `mm` CLI logged in + initialized (`mm doctor`), and a keccak lib.
"""
import sys
import time
from decimal import Decimal

sys.path.insert(0, __import__("os").path.dirname(__file__))
import ophis_common as oc  # noqa: E402

ZERO = "0x0000000000000000000000000000000000000000"
NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"


def main() -> None:
    argv = sys.argv[1:]
    if len(argv) < 6:
        print(__doc__.strip())
        sys.exit(1)
    chain_id = int(argv[0])
    sell_token, sell_dec = argv[1], int(argv[2])
    amount = argv[3]
    buy_token, buy_dec = argv[4], int(argv[5])
    slippage_bps = int(argv[6]) if len(argv) > 6 else 50
    referral = argv[7] if len(argv) > 7 else None

    if sell_token.lower() in (ZERO, NATIVE):
        sys.exit("Native-token sells use CoW eth-flow (not this script). Sell WETH instead.")
    if buy_token.lower() in (ZERO, NATIVE):
        sys.exit("Native-token buys aren't supported here — buy WETH and unwrap it yourself.")
    if not (0 <= slippage_bps <= 5000):
        sys.exit("slippage_bps must be within [0, 5000] (0%..50%).")

    oc.mm_require_ready()
    wallet = oc.mm_wallet_address()
    print(f"MetaMask wallet: {wallet}")
    oc.enroll_wallet(wallet)

    # 1-2. appData (partner fee) + quote. The 1bp stable tier is DERIVED from a verified
    # stablecoin registry (never a caller flag), so a mislabeled pair can't undercharge.
    is_stable = oc.is_stable_pair(chain_id, sell_token, buy_token)
    full_app_data, app_hash = oc.build_app_data(referral_code=referral, is_stable_pair=is_stable)
    sell_atomic = oc.to_atomic(amount, sell_dec)
    quote = oc.get_quote(chain_id, sell_token, buy_token, sell_atomic, wallet, full_app_data, app_hash)
    # Require the binding fields to be PRESENT — a missing field must not silently default into the
    # request (which would defeat the gross bind below).
    for _f in ("sellAmount", "buyAmount", "feeAmount"):
        if _f not in quote:
            sys.exit(f"orderbook quote is missing required field {_f!r}: {quote}")
    quote_buy = int(quote["buyAmount"])
    quote_sell = int(quote["sellAmount"])
    quote_fee = int(quote["feeAmount"])
    if quote_buy <= 0:
        sys.exit(f"quote returned no buyAmount: {quote}")

    # Bind the SIGNED order to the user's intent. We ALWAYS sign feeAmount 0 (Ophis/CoW take the
    # fee from surplus + the appData partner fee), so bind the GROSS (quote sellAmount + feeAmount)
    # to the requested amount rather than rejecting a quote just because it split a non-zero fee out.
    # An honest sell quote's gross equals the request exactly; any drift (over or under) is refused.
    gross = quote_sell + quote_fee
    if gross != sell_atomic:
        sys.exit(f"quote gross (sellAmount+feeAmount = {gross}) != requested ({sell_atomic}). Aborting to avoid signing a different amount.")

    # Self-set validTo (do not trust the orderbook's expiry). Order valid ~20 min.
    valid_to = int(time.time()) + 1200

    min_buy = quote_buy * (10_000 - slippage_bps) // 10_000
    if min_buy <= 0:
        sys.exit("computed minimum buy amount is 0 — refusing an accept-any-price order.")
    print(f"Quote: ~{Decimal(quote_buy) / (Decimal(10) ** buy_dec)} buy token "
          f"(min after {slippage_bps}bps: {Decimal(min_buy) / (Decimal(10) ** buy_dec)})")

    # 3. Publish the full appData so solvers honor the partner fee for this hash.
    oc.put_app_data(chain_id, app_hash, full_app_data)

    # 4. Ensure the VaultRelayer allowance covers the sell (allowance-aware, USDT-safe).
    relayer = oc.vault_relayer(chain_id)
    current = oc.read_allowance(chain_id, sell_token, wallet, relayer)
    if current is not None and current >= sell_atomic:
        print("Sufficient VaultRelayer allowance — skipping approve.")
    else:
        if current is None or current > 0:
            # Non-zero (or unknown, if the allowance read failed) insufficient allowance:
            # reset to 0 first — Ethereum USDT + clones revert on a non-zero -> non-zero
            # approve, and on a failed read we can't rule that out — then set max.
            print("Resetting existing allowance to 0 (USDT-safe) via mm ...")
            oc.mm_send_transaction(chain_id, sell_token, oc.encode_approve(relayer, 0),
                                   "Reset CoW VaultRelayer allowance to 0")
        print("Approving sell token -> VaultRelayer via mm ...")
        oc.mm_send_transaction(chain_id, sell_token, oc.encode_approve(relayer, oc.MAX_UINT256),
                               "Approve CoW VaultRelayer for an Ophis swap")

    # 5. EIP-712-sign the GPv2 order (SIGNED order carries appData = the bytes32 hash).
    signed_message = {
        "sellToken": sell_token,
        "buyToken": buy_token,
        "receiver": wallet,
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
    typed_data = oc.build_order_typed_data(chain_id, signed_message)
    print("Signing the CoW order (EIP-712) via mm ...")
    signature = oc.mm_sign_typed_data(
        chain_id, typed_data,
        f"Ophis/CoW order: sell {amount} of {sell_token} for {buy_token}",
    )

    # 6. Submit the order: appData = the FULL json string (+ appDataHash) on the wire.
    order_body = {
        **signed_message,
        "appData": full_app_data,
        "appDataHash": app_hash,
        "signingScheme": "eip712",
        "signature": signature,
        "from": wallet,
    }
    order_uid = oc.post_order(chain_id, order_body)

    base = oc.orderbook_url(chain_id)
    print("\n=== SUCCESS — order signed + submitted; solvers settle it in the next batch ===")
    print(f"Order UID: {order_uid}")
    print(f"Status:    {base}/api/v1/orders/{order_uid}")
    print(f"Explorer:  https://explorer.ophis.fi/orders/{order_uid}")


if __name__ == "__main__":
    main()
