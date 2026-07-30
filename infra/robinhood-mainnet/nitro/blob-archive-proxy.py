#!/usr/bin/env python3
"""Fail-closed Beacon blob compatibility proxy backed by Blobscan.

Nitro v3.11 requests:
  GET /eth/v1/beacon/blobs/{slot}?versioned_hashes=0x...

and expects ``{"data": ["0x<131072-byte blob>", ...]}``. Blobscan preserves
historical blobs permanently but exposes them by versioned hash. Nitro
recomputes each KZG commitment and compares its versioned hash with the hash
from Ethereum L1, so this service is an availability adapter, not a new trust
root.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HASH_RE = re.compile(r"^0x01[0-9a-fA-F]{62}$")
PATH_RE = re.compile(r"^/eth/v1/beacon/blobs/([0-9]+)$")
EXPECTED_HEX_LENGTH = 2 + 131_072 * 2
MAX_BLOBS_PER_REQUEST = 16

BLOBSCAN_BASE_URL = os.environ.get("BLOBSCAN_BASE_URL", "https://api.blobscan.com").rstrip("/")
UPSTREAM_TIMEOUT_SECONDS = float(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "30"))
LISTEN_HOST = os.environ.get("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "3500"))


def _validate_blob(value: object) -> str:
    if not isinstance(value, str) or len(value) != EXPECTED_HEX_LENGTH:
        raise ValueError("archive returned a blob with an invalid length")
    if not value.startswith("0x"):
        raise ValueError("archive returned a non-hex blob")
    try:
        bytes.fromhex(value[2:])
    except ValueError as exc:
        raise ValueError("archive returned a non-hex blob") from exc
    return value.lower()


def fetch_blob(versioned_hash: str) -> str:
    if not HASH_RE.fullmatch(versioned_hash):
        raise ValueError("invalid EIP-4844 versioned hash")

    url = f"{BLOBSCAN_BASE_URL}/blobs/{versioned_hash.lower()}/data"
    request = urllib.request.Request(url, headers={"User-Agent": "ophis-blob-archive/1"})
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
        # Do not cache before Nitro's KZG/versioned-hash verification. A
        # well-formed but substituted upstream blob must be retried from the
        # recovered archive rather than poison a persistent local cache.
        return _validate_blob(json.load(response))


class Handler(BaseHTTPRequestHandler):
    server_version = "OphisBlobArchive/1"

    def _json(self, status: int, value: object) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/healthz":
            self._json(200, {"status": "ok"})
            return
        if not PATH_RE.fullmatch(parsed.path):
            self._json(404, {"code": 404, "message": "not found"})
            return

        hashes = urllib.parse.parse_qs(parsed.query).get("versioned_hashes", [])
        if not hashes:
            self._json(400, {"code": 400, "message": "versioned_hashes is required"})
            return
        if len(hashes) > MAX_BLOBS_PER_REQUEST or any(not HASH_RE.fullmatch(h) for h in hashes):
            self._json(400, {"code": 400, "message": "invalid versioned_hashes"})
            return

        try:
            self._json(200, {"data": [fetch_blob(versioned_hash) for versioned_hash in hashes]})
        except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as exc:
            # Never return partial data. Nitro then tries its configured fallback
            # or halts derivation instead of accepting unverifiable DA.
            self.log_error("archive fetch failed: %s", exc)
            self._json(502, {"code": 502, "message": "historical blob unavailable"})

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
