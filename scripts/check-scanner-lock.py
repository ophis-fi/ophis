#!/usr/bin/env python3
"""Reject Python scanner manifest/lock drift without installing dependencies."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1] / "tools/toxic-pool-risk"


def pins(path):
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "--hash=")):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^ \\]+)(?: \\)?", line)
        if not match:
            raise ValueError(f"Unsupported requirement in {path.name}; use exact package pins")
        name, version = match.groups()
        result[re.sub(r"[-_.]+", "-", name).lower()] = version
    if not result:
        raise ValueError(f"No dependencies in {path.name}")
    return result


if __name__ == "__main__":
    required = pins(ROOT / "requirements-scanner.txt")
    locked = pins(ROOT / "requirements-scanner.lock")
    for name, version in required.items():
        if locked.get(name) != version:
            raise SystemExit(f"Scanner lock is stale for {name}; regenerate the hashed lock")
    print(f"Scanner hash lock matches all {len(required)} direct dependency pins ({len(locked)} total)")
