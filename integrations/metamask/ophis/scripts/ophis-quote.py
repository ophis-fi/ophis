#!/usr/bin/env python3
"""Ophis (CoW Protocol) same-chain swap QUOTE — no execution, no wallet needed.

Usage:
  ophis-quote.py <chain_id> <sell_token> <sell_decimals> <amount> <buy_token> <buy_decimals> [referral_code]

Example (100 USDC -> WETH on Base):
  ophis-quote.py 8453 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 6 100 \\
                 0x4200000000000000000000000000000000000006 18
"""
import sys
from decimal import Decimal

sys.path.insert(0, __import__("os").path.dirname(__file__))
import ophis_common as oc  # noqa: E402

ZERO = "0x0000000000000000000000000000000000000000"


def main() -> None:
    argv = [a for a in sys.argv[1:] if a != "--stable"]
    is_stable = "--stable" in sys.argv
    if len(argv) < 6:
        print(__doc__.strip())
        sys.exit(1)
    chain_id = int(argv[0])
    sell_token, sell_dec = argv[1], int(argv[2])
    amount = argv[3]
    buy_token, buy_dec = argv[4], int(argv[5])
    referral = argv[6] if len(argv) > 6 else None

    full_app_data, app_hash = oc.build_app_data(referral_code=referral, is_stable_pair=is_stable)
    sell_atomic = oc.to_atomic(amount, sell_dec)
    quote = oc.get_quote(chain_id, sell_token, buy_token, sell_atomic, ZERO, full_app_data, app_hash)

    buy_wei = int(quote.get("buyAmount", "0"))
    print(f"=== Ophis quote (chain {chain_id}) ===")
    print(f"sell:  {amount} (token {sell_token})")
    print(f"buy:  ~{Decimal(buy_wei) / (Decimal(10) ** buy_dec)} (token {buy_token})")
    print(f"buyAmount (wei):  {buy_wei}")
    print(f"feeAmount (wei):  {int(quote.get('feeAmount', '0'))}")
    print(f"validTo:          {quote.get('validTo')}")
    fee_bps = oc.OPHIS_STABLE_VOLUME_FEE_BPS if is_stable else oc.OPHIS_VOLUME_FEE_BPS
    print(f"partner fee:      {fee_bps} bps (in appData; MEV-protected, surplus returned)")


if __name__ == "__main__":
    main()
