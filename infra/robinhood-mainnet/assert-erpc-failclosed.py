#!/usr/bin/env python3
"""Lock Robinhood's zero-budget RPC trust and transaction-relay topology."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

EXPECTED_ACTIVE_LINES = """
logLevel: warn
projects:
  - id: main
    networks:
      - architecture: evm
        evm:
          chainId: 4663
          enforceBlockAvailability: false
          servedTip:
            enabledFor:
              - latest
          integrity:
            enforceHighestBlock: false
            enforceNonNullTaggedBlocks: true
        failsafe:
          - matchMethod: "eth_call|eth_getBalance|eth_getCode|eth_getStorageAt|eth_estimateGas|eth_feeHistory|eth_getTransactionCount|eth_getBlockByHash|eth_getTransactionByHash|eth_getTransactionReceipt"
            timeout:
              duration: 12s
            consensus:
              maxParticipants: 2
              agreementThreshold: 2
              maxWaitOnResult: 5s
              maxWaitOnEmpty: 5s
              disputeBehavior: returnError
              lowParticipantsBehavior: returnError
          - matchMethod: "*"
            timeout:
              duration: 30s
            retry:
              maxAttempts: 3
              delay: 200ms
              backoffMaxDelay: 1s
              backoffFactor: 1.5
              jitter: 50ms
    upstreamDefaults:
      evm:
        statePollerInterval: 1s
        statePollerDebounce: 1s
    upstreams:
      - id: ophis-self-rbh
        endpoint: http://ophis-rbh-node:8547
        failsafe:
          - matchMethod: "*"
            timeout:
              duration: 30s
            retry:
              maxAttempts: 3
              delay: 200ms
              backoffMaxDelay: 1s
              backoffFactor: 1.5
              jitter: 50ms
      - id: robinhood-official
        endpoint: https://rpc.mainnet.chain.robinhood.com
        ignoreMethods:
          - eth_blockNumber
          - eth_getBlockByNumber
          - eth_getLogs
        failsafe:
          - matchMethod: "*"
            timeout:
              duration: 12s
            retry:
              maxAttempts: 3
              delay: 200ms
              backoffMaxDelay: 1s
              backoffFactor: 1.5
              jitter: 50ms
""".strip()


def active_lines(text: str) -> str:
    return "\n".join(
        line.rstrip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def main(path: str, strict: bool = False) -> int:
    del strict
    source = Path(path)
    try:
        actual = active_lines(source.read_text())
    except OSError as exc:
        print(f"ERROR: cannot read {source}: {exc}", file=sys.stderr)
        return 14
    if actual != EXPECTED_ACTIVE_LINES:
        print(
            "ERROR: Robinhood RPC config changed outside the reviewed shape "
            "(2-of-2 protected state reads, self-only logs/traces, forwarding-capable writes).",
            file=sys.stderr,
        )
        return 14
    print(
        "OK: Robinhood RPC guard — 2-of-2 protected state reads, self-only logs/traces, "
        "and a forwarding-capable transaction path."
    )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="configs/erpc.yaml.tmpl")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    sys.exit(main(args.path, strict=args.strict))
