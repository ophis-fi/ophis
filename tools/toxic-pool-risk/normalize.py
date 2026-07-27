#!/usr/bin/env python3
"""Normalize toxic-pool-utils output into the Ophis liquidity-risk feed."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
ALLOWED_FLAGS = {"critical", "high", "none"}
DEFAULT_MAX_AGE_SECONDS = 6 * 60 * 60


class ValidationError(ValueError):
    pass


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def iso8601(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any, field: str) -> datetime:
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, timezone.utc)
        if isinstance(value, str):
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (OverflowError, ValueError):
        pass
    raise ValidationError(f"{field} is not a valid timestamp")


def require_int(value: Any, field: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValidationError(f"{field} must be an integer >= {minimum}")
    return value


def normalize_reason(reason: Any) -> str:
    if not isinstance(reason, str) or not reason.strip():
        raise ValidationError("ui_reasons must contain non-empty strings")
    return " ".join(reason.split())[:500]


def normalize_row(row: Any) -> tuple[str, dict[str, Any]]:
    if not isinstance(row, dict):
        raise ValidationError("each scanner row must be an object")
    address = row.get("pool")
    if not isinstance(address, str) or not ADDRESS_RE.fullmatch(address):
        raise ValidationError(f"invalid pool address: {address!r}")
    address = address.lower()

    flag = row.get("ui_flag")
    if flag not in ALLOWED_FLAGS:
        raise ValidationError(f"pool {address} has unsupported ui_flag {flag!r}")
    row_errors = row.get("errors") or []
    if not isinstance(row_errors, list) or any(not isinstance(item, str) for item in row_errors):
        raise ValidationError(f"pool {address} errors must be a string array")

    reasons = [normalize_reason(item) for item in (row.get("ui_reasons") or [])]
    if row_errors:
        status = "scan_error"
        severity = "unknown"
        reasons = [f"scanner error: {normalize_reason(item)}" for item in row_errors]
    elif flag == "none":
        status = "clear"
        severity = "none"
    else:
        status = "flagged"
        severity = flag
        if not reasons:
            raise ValidationError(f"flagged pool {address} has no ui_reasons")

    return address, {
        "status": status,
        "severity": severity,
        "reasons": reasons,
        "evidenceHash": "0x" + hashlib.sha256(canonical_bytes(row)).hexdigest(),
    }


def normalize(
    raw: Any,
    *,
    expected_chain_id: int,
    now: datetime,
    max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValidationError("scanner output must be an object")
    chain_id = require_int(raw.get("chain_id"), "chain_id", 1)
    if chain_id != expected_chain_id:
        raise ValidationError(f"chain_id mismatch: expected {expected_chain_id}, got {chain_id}")
    head_block = require_int(raw.get("head_block"), "head_block")
    head_time = parse_timestamp(raw.get("head_timestamp"), "head_timestamp")
    if head_time > now + timedelta(minutes=5):
        raise ValidationError("head_timestamp is implausibly far in the future")
    age_seconds = (now - head_time).total_seconds()
    if age_seconds > max_age_seconds:
        raise ValidationError(
            f"scanner output is stale: head is {int(age_seconds)}s old (maximum {max_age_seconds}s)"
        )

    rows = raw.get("rows")
    if not isinstance(rows, list):
        raise ValidationError("rows must be an array")
    declared_count = require_int(raw.get("pool_count"), "pool_count")
    if declared_count != len(rows):
        raise ValidationError(f"pool_count mismatch: declared {declared_count}, found {len(rows)}")
    top_errors = raw.get("errors") or []
    if not isinstance(top_errors, list) or any(not isinstance(item, str) for item in top_errors):
        raise ValidationError("errors must be a string array")
    factories = raw.get("factories") or []
    if not isinstance(factories, list):
        raise ValidationError("factories must be an array")
    for factory in factories:
        if not isinstance(factory, dict):
            raise ValidationError("each factory summary must be an object")
        family = str(factory.get("family") or factory.get("factory") or "unknown")
        factory_errors = factory.get("errors") or []
        if not isinstance(factory_errors, list) or any(
            not isinstance(item, str) for item in factory_errors
        ):
            raise ValidationError(f"factory {family} errors must be a string array")
        if factory.get("unsupported"):
            top_errors.append(f"factory {family} is unsupported")
        top_errors.extend(f"factory {family}: {item}" for item in factory_errors)

    pools: dict[str, dict[str, Any]] = {}
    for row in rows:
        address, normalized = normalize_row(row)
        if address in pools:
            raise ValidationError(f"duplicate pool address: {address}")
        pools[address] = normalized

    counts = {
        "critical": sum(pool["severity"] == "critical" for pool in pools.values()),
        "high": sum(pool["severity"] == "high" for pool in pools.values()),
        "clear": sum(pool["status"] == "clear" for pool in pools.values()),
        "scan_error": sum(pool["status"] == "scan_error" for pool in pools.values()),
    }
    status = "scan_error" if top_errors or counts["scan_error"] else "complete"
    generated_at = now.astimezone(timezone.utc)
    feed = {
        "schemaVersion": 1,
        "chainId": chain_id,
        "generatedAt": iso8601(generated_at),
        "headBlock": head_block,
        "headTimestamp": iso8601(head_time),
        "expiresAt": iso8601(generated_at + timedelta(seconds=max_age_seconds)),
        "coverage": "curve-provider-context-v1",
        "scanner": {
            "repository": "https://github.com/wavey0x/toxic-pool-utils",
            "revision": os.environ.get("TOXIC_SCANNER_REVISION", "unknown"),
        },
        "status": status,
        "errors": [normalize_reason(item) for item in top_errors],
        "counts": counts,
        "pools": dict(sorted(pools.items())),
    }
    feed["contentHash"] = "sha256:" + hashlib.sha256(canonical_bytes(feed)).hexdigest()
    return feed


def atomic_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--chain-id", required=True, type=int)
    parser.add_argument("--max-age-seconds", type=int, default=DEFAULT_MAX_AGE_SECONDS)
    args = parser.parse_args()
    if args.max_age_seconds <= 0:
        parser.error("--max-age-seconds must be positive")

    try:
        with args.input.open(encoding="utf-8") as handle:
            raw = json.load(handle)
        feed = normalize(
            raw,
            expected_chain_id=args.chain_id,
            now=datetime.now(timezone.utc),
            max_age_seconds=args.max_age_seconds,
        )
        atomic_write(args.output, feed)
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        raise SystemExit(f"risk-feed normalization failed: {exc}") from exc


if __name__ == "__main__":
    main()
