#!/usr/bin/env python3
"""Opt the Greg deployer EOA into HyperEVM big-block mode (30M gas / 60s).
Required because GPv2Settlement deploy ~5M gas exceeds the 3M small-block limit.

Pre-req: the deployer EOA must be a 'HyperCore user' — i.e. have at any point
received a HyperCore asset (USDC etc). For testnet, fund the deployer with a
small USDC drop on HyperCore Testnet first; for mainnet, the deployer has to
have done a real deposit. Without this prereq the opt-in is rejected.

Usage:
  python3 infra/hyperevm/opt-in-big-blocks.py {testnet|mainnet}
"""
import sys
import subprocess
from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("testnet", "mainnet"):
        print("Usage: opt-in-big-blocks.py {testnet|mainnet}", file=sys.stderr)
        sys.exit(2)

    network = sys.argv[1]
    base_url = (
        constants.TESTNET_API_URL if network == "testnet" else constants.MAINNET_API_URL
    )

    pk = subprocess.check_output(
        [
            "security",
            "find-generic-password",
            "-a",
            "greg-megaeth-deployer",
            "-s",
            "greg-megaeth-deployer",
            "-w",
        ],
        text=True,
    ).strip()
    wallet = Account.from_key(pk)
    print(f"Deployer EOA: {wallet.address}")
    print(f"Network:      {network} ({base_url})")

    ex = Exchange(wallet, base_url=base_url)
    res = ex.use_big_blocks(True)
    print(f"\nResponse: {res}")

    if res.get("status") == "ok":
        print("\n✓ Opt-in OK. Subsequent HyperEVM txs from this EOA route to big blocks.")
    else:
        print("\n✗ Opt-in failed. Common cause: deployer is not yet a HyperCore user.")
        print("  Send any HyperCore asset (e.g. tiny USDC) to this address first, then retry.")
        sys.exit(1)


if __name__ == "__main__":
    main()
