#!/usr/bin/env python3
"""Enforce Robinhood's zero-budget sovereign RPC trust boundary."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Closed-world lock: every active line in the authoritative eRPC template must
# match this reviewed configuration. Comments may evolve without weakening the
# trust boundary; adding an upstream, directive, placeholder, or override fails.
EXPECTED_ACTIVE_LINES = """
logLevel: warn
projects:
  - id: main
    networks:
      - architecture: evm
        evm:
          chainId: 4663
          integrity:
            enforceHighestBlock: true
            enforceNonNullTaggedBlocks: true
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
    upstreamDefaults:
      evm:
        statePollerInterval: 1s
        statePollerDebounce: 300ms
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
""".strip()


def active_lines(text: str) -> str:
    return "\n".join(
        line.rstrip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def main(path: str, strict: bool = False) -> int:
    del strict  # Retained for compatibility with the existing CI invocation.
    source = Path(path)
    try:
        actual = active_lines(source.read_text())
    except OSError as exc:
        print(f"ERROR: cannot read {source}: {exc}", file=sys.stderr)
        return 14

    if actual != EXPECTED_ACTIVE_LINES:
        print(
            "ERROR: Robinhood sovereign RPC config changed outside the reviewed "
            "closed-world shape (one internal Cadia Nitro upstream).",
            file=sys.stderr,
        )
        return 14

    print(
        "OK: Robinhood sovereign RPC guard — exactly one internal Cadia Nitro "
        "upstream; no external provider, placeholder, or claimed quorum."
    )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="configs/erpc.yaml.tmpl")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    sys.exit(main(args.path, strict=args.strict))
