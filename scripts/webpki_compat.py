#!/usr/bin/env python3
"""Verify RustSec #3419's roots shim before correcting its version-only finding."""
import argparse
from pathlib import Path
import sys
import tomllib

ADVISORY = "RUSTSEC-2026-0381"
SOURCE = "registry+https://github.com/rust-lang/crates.io-index"
CHECKSUMS = {
    "0.26.11": "521bc38abb08001b01866da9f51eb7c5d647a19260e00054a8c7fd5f9e57f7a9",
    "1.0.10": "1c1c8e20c8a38fc7d65abfe74eb7280e4aa667e8eec8bc84996d2874810748d9",
}


def verified_shim(lock_path):
    packages = tomllib.loads(Path(lock_path).read_text())["package"]
    if not isinstance(packages, list) or not packages:
        raise ValueError("missing Cargo packages")
    roots = [p for p in packages if p["name"] == "webpki-roots"]
    if not any(p["version"] == "0.26.11" for p in roots):
        return False
    # shortcut: remove this correction once RustSec #3419 reaches all scanners.
    if len(roots) != 2 or {p["version"] for p in roots} != set(CHECKSUMS):
        raise ValueError("roots shim requires exactly the reviewed 1.0.10 payload")
    for package in roots:
        if package.get("source") != SOURCE or package.get("checksum") != CHECKSUMS[package["version"]]:
            raise ValueError("unverified webpki-roots source/checksum")
        expected = ["webpki-roots 1.0.10"] if package["version"] == "0.26.11" else ["rustls-pki-types"]
        if package.get("dependencies") != expected:
            raise ValueError("unexpected roots shim/payload dependency edge")
    return True


def deny_config(lock_path, config_path):
    text = Path(config_path).read_text()
    if not verified_shim(lock_path):
        return text
    before = tomllib.loads(text)
    marker = "ignore = ["
    if text.count(marker) != 1 or ADVISORY in before["advisories"]["ignore"]:
        raise ValueError("unexpected cargo-deny ignore configuration")
    corrected = text.replace(marker, marker + f'\n    "{ADVISORY}",', 1)
    before["advisories"]["ignore"].insert(0, ADVISORY)
    if tomllib.loads(corrected) != before:
        raise ValueError("cargo-deny correction changed unrelated policy")
    return corrected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lock")
    parser.add_argument("--deny-config")
    args = parser.parse_args()
    try:
        if args.deny_config:
            print(deny_config(args.lock, args.deny_config), end="")
        elif verified_shim(args.lock):
            print(ADVISORY)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"ERROR: unverified WebPKI compatibility graph: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
