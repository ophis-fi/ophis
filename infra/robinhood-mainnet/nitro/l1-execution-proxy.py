#!/usr/bin/env python3
"""Rate-shaped zero-budget Ethereum L1 RPC for Nitro genesis derivation."""

from __future__ import annotations

import copy
import json
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GENERAL_UPSTREAM = "https://eth.drpc.org"
LOG_UPSTREAM = "https://rpc.mevblocker.io"
MAX_BODY_BYTES = 1_048_576
MAX_LOG_BLOCKS = 50
MIN_LOG_INTERVAL = 0.25
MAX_ATTEMPTS = 3

_log_lock = threading.Lock()
_last_log_request = 0.0


def _post(url: str, payload: dict[str, object], timeout: float = 5.0) -> dict[str, object]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "ophis-l1-deriver/1"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise ValueError("upstream returned a non-object JSON-RPC response")
    return result


def _is_retryable(response: dict[str, object]) -> bool:
    error = response.get("error")
    if not isinstance(error, dict):
        return False
    code = error.get("code")
    message = str(error.get("message", "")).lower()
    return (
        code in {-32005, -32029, 12}
        or "rate limit" in message
        or "usage limit" in message
        or "too many" in message
    )


def _log_bounds(payload: dict[str, object]) -> tuple[int, int]:
    params = payload.get("params")
    if not isinstance(params, list) or not params or not isinstance(params[0], dict):
        raise ValueError("invalid eth_getLogs parameters")
    start_raw = params[0].get("fromBlock")
    end_raw = params[0].get("toBlock")
    if not isinstance(start_raw, str) or not isinstance(end_raw, str):
        raise ValueError("eth_getLogs requires explicit block bounds")
    start = int(start_raw, 16)
    end = int(end_raw, 16)
    if end < start or end - start + 1 > 10_000:
        raise ValueError("invalid or excessive eth_getLogs range")
    return start, end


def _rate_limited_fallback_request(
    payload: dict[str, object], *, validate_log_range: bool = False
) -> dict[str, object]:
    global _last_log_request
    if validate_log_range:
        _log_bounds(payload)
    with _log_lock:
        for attempt in range(MAX_ATTEMPTS):
            delay = MIN_LOG_INTERVAL - (time.monotonic() - _last_log_request)
            if delay > 0:
                time.sleep(delay)
            try:
                response = _post(LOG_UPSTREAM, payload)
            except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError):
                response = {}
            _last_log_request = time.monotonic()
            if response and not _is_retryable(response):
                return response
            time.sleep(min(2**attempt, 4))
    raise RuntimeError("historical log upstream remained unavailable")


def dispatch(payload: dict[str, object]) -> dict[str, object]:
    method = payload.get("method")
    if not isinstance(method, str) or payload.get("jsonrpc") != "2.0":
        raise ValueError("invalid JSON-RPC request")
    if method == "eth_getLogs":
        start, end = _log_bounds(payload)
        logs: list[object] = []
        for chunk_start in range(start, end + 1, MAX_LOG_BLOCKS):
            chunk = copy.deepcopy(payload)
            chunk_filter = chunk["params"][0]  # validated by _log_bounds
            chunk_filter["fromBlock"] = hex(chunk_start)
            chunk_filter["toBlock"] = hex(min(chunk_start + MAX_LOG_BLOCKS - 1, end))
            response = _rate_limited_fallback_request(chunk, validate_log_range=True)
            if "error" in response:
                return response
            result = response.get("result")
            if not isinstance(result, list):
                raise ValueError("eth_getLogs upstream returned a non-list result")
            logs.extend(result)
        return {"jsonrpc": "2.0", "id": payload.get("id"), "result": logs}

    response = _post(GENERAL_UPSTREAM, payload)
    if _is_retryable(response):
        # A bounded fallback for transient dRPC routing/capacity failures.
        return _rate_limited_fallback_request(payload)
    return response


class Handler(BaseHTTPRequestHandler):
    server_version = "OphisL1Deriver/1"

    def _write(self, status: int, value: object) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._write(200, {"status": "ok"})
        else:
            self._write(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("JSON-RPC batching is not supported")
            self._write(200, dispatch(payload))
        except (OSError, RuntimeError, ValueError, urllib.error.URLError, json.JSONDecodeError) as exc:
            self.log_error("L1 request failed: %s", exc)
            self._write(
                503,
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32005, "message": "L1 derivation upstream unavailable"},
                },
            )


def main() -> None:
    ThreadingHTTPServer(("0.0.0.0", 8545), Handler).serve_forever()


if __name__ == "__main__":
    main()
