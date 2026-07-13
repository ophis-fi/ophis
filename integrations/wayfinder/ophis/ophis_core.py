"""Ophis (CoW Protocol) order primitives for the Wayfinder adapter: per-chain
orderbook endpoints, the Ophis partner-fee appData, the GPv2 order + its EIP-712
typed data, and the orderbook REST calls (quote / put app-data / submit).

Ophis is CoW Protocol intent settlement: a swap is an OFF-CHAIN EIP-712-signed
order, not an on-chain swap tx. This module builds and submits that order; the
adapter supplies the signature (via Wayfinder's typed-data callback) and the
ERC-20 approval (via Wayfinder's audited allowance helper). No signing, no web3,
and no private keys live here — it is pure order construction + REST.

Addresses / endpoints mirror @ophis/sdk and @ophis/agent-swap.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request

# ── Per-chain orderbook base URL (@ophis/sdk orderbook.ts). Only the chains that
# also exist in Wayfinder's SUPPORTED_CHAINS are reachable from this adapter; the
# adapter enforces that intersection (Optimism/Unichain/Gnosis/Linea/Ink are Ophis
# chains that Wayfinder does not support, so they are intentionally absent here). ─
ORDERBOOK_URLS = {
    1:     "https://api.cow.fi/mainnet",
    56:    "https://api.cow.fi/bnb",
    137:   "https://api.cow.fi/polygon",
    8453:  "https://api.cow.fi/base",
    42161: "https://api.cow.fi/arbitrum_one",
    43114: "https://api.cow.fi/avalanche",
}

# ── Settlement (EIP-712 verifyingContract) + VaultRelayer (approve spender) ────
# All six adapter chains use the canonical CoW deployment (the non-canonical
# Optimism/Unichain deployments are not reachable from Wayfinder).
CANONICAL_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"
CANONICAL_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110"

# ── Ophis partner fee (partner-fee.ts). The fee rides in appData (partnerFee),
# so the signed order's own feeAmount is 0. ───────────────────────────────────
OPHIS_PARTNER_FEE_RECIPIENT = "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"  # Ophis Safe
OPHIS_VOLUME_FEE_BPS = 5
OPHIS_STABLE_VOLUME_FEE_BPS = 1
APP_DATA_VERSION = "1.4.0"
REBATE_INDEXER_URL = "https://rebates.ophis.fi"

# ── GPv2 Order EIP-712 (protocol constant; @ophis/agent-swap order-types.ts) ───
GPV2_ORDER_TYPES = {
    "Order": [
        {"name": "sellToken", "type": "address"},
        {"name": "buyToken", "type": "address"},
        {"name": "receiver", "type": "address"},
        {"name": "sellAmount", "type": "uint256"},
        {"name": "buyAmount", "type": "uint256"},
        {"name": "validTo", "type": "uint32"},
        {"name": "appData", "type": "bytes32"},
        {"name": "feeAmount", "type": "uint256"},
        {"name": "kind", "type": "string"},
        {"name": "partiallyFillable", "type": "bool"},
        {"name": "sellTokenBalance", "type": "string"},
        {"name": "buyTokenBalance", "type": "string"},
    ],
}
_EIP712_DOMAIN_TYPE = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]

SUPPORTED_CHAIN_IDS = frozenset(ORDERBOOK_URLS)


def orderbook_url(chain_id: int) -> str:
    url = ORDERBOOK_URLS.get(int(chain_id))
    if not url:
        raise ValueError(
            f"chain {chain_id} is not an Ophis chain reachable from Wayfinder. "
            f"Supported: {sorted(ORDERBOOK_URLS)}"
        )
    return url


def build_order_typed_data(chain_id: int, order: dict) -> dict:
    """The full EIP-712 typed data to sign for a GPv2/Ophis order. `order["appData"]`
    MUST be the bytes32 appDataHash (not the full JSON string)."""
    return {
        "types": {"EIP712Domain": _EIP712_DOMAIN_TYPE, **GPV2_ORDER_TYPES},
        "primaryType": "Order",
        "domain": {
            "name": "Gnosis Protocol",
            "version": "v2",
            "chainId": int(chain_id),
            "verifyingContract": CANONICAL_SETTLEMENT,
        },
        "message": order,
    }


def keccak256(data: bytes) -> bytes:
    """keccak256 via eth-utils (a hard dep of wayfinder-paths via web3/eth-account)."""
    from eth_utils import keccak as _keccak

    return _keccak(data)


def build_app_data(referral_code: str | None = None, is_stable_pair: bool = False):
    """Return (full_app_data_string, app_data_hash_0x). appCode MUST be 'ophis' or the
    rebate indexer silently drops the order. Self-consistent: hash == keccak256(full)."""
    metadata = {
        "partnerFee": {
            "volumeBps": OPHIS_STABLE_VOLUME_FEE_BPS if is_stable_pair else OPHIS_VOLUME_FEE_BPS,
            "recipient": OPHIS_PARTNER_FEE_RECIPIENT,
        },
        "hooks": {},
    }
    if referral_code:
        code = referral_code.strip().lower()
        if not re.match(r"^[a-z0-9_-]{3,64}$", code):
            raise ValueError(f"invalid referral code {referral_code!r}: must match [a-z0-9_-]{{3,64}}")
        metadata["ophisReferrer"] = {"code": code}
    doc = {"appCode": "ophis", "metadata": metadata, "version": APP_DATA_VERSION}
    full = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    return full, "0x" + keccak256(full.encode("utf-8")).hex()


def to_atomic(amount_human: str, decimals: int) -> int:
    """Whole units -> base units, EXACTLY (pure integer math — no float/Decimal rounding).
    Rejects excess precision instead of truncating/rounding a fraction the token cannot
    represent (e.g. 0.5 of a 0-decimal token would otherwise round to 1)."""
    s = str(amount_human).strip()
    m = re.match(r"^(\d+)(?:\.(\d+))?$", s)
    if not m:
        raise ValueError(f'amount must be a plain decimal (e.g. "1.5"): {amount_human!r}')
    frac = (m.group(2) or "").rstrip("0")  # trailing zeros carry no precision
    if len(frac) > decimals:
        raise ValueError(f'amount "{amount_human}" needs {len(frac)} decimals but the token supports only {decimals}.')
    atomic = int(m.group(1) + frac.ljust(decimals, "0"))
    if atomic <= 0:
        raise ValueError(f"amount must be > 0: {amount_human!r}")
    return atomic


def _http(method: str, url: str, body: dict | None = None, timeout: int = 60) -> dict:
    if not url.lower().startswith("https://"):
        raise ValueError(f"refusing non-HTTPS URL: {url}")  # block file://, http://, etc.
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- URL is scheme-guarded to https:// above and built from the fixed ORDERBOOK_URLS https map.
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url} -> HTTP {e.code}: {e.read().decode(errors='replace')[:500]}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"{method} {url} -> network error: {e}") from e


def get_quote(chain_id, sell_token, buy_token, sell_amount_atomic, from_addr, app_data_hash) -> dict:
    # Send the appData HASH (not the full string) to the quote — CoW's strict app-data
    # schema (additionalProperties:false) rejects the Ophis-only `ophisReferrer` key, so
    # an inline full doc can 400 a referral'd quote. The full string is only PUT +
    # submitted (those paths accept the extension). Matches @ophis/agent-swap swap.ts.
    body = {
        "sellToken": sell_token, "buyToken": buy_token, "from": from_addr, "receiver": from_addr,
        "kind": "sell", "sellAmountBeforeFee": str(sell_amount_atomic),
        "partiallyFillable": False, "sellTokenBalance": "erc20", "buyTokenBalance": "erc20",
        "priceQuality": "optimal", "signingScheme": "eip712", "onchainOrder": False,
        "appData": app_data_hash, "appDataHash": app_data_hash, "validFor": 1200,
    }
    res = _http("POST", f"{orderbook_url(chain_id)}/api/v1/quote", body=body)
    return res.get("quote") or res


def put_app_data(chain_id: int, app_data_hash: str, full_app_data: str) -> None:
    _http("PUT", f"{orderbook_url(chain_id)}/api/v1/app_data/{app_data_hash}", body={"fullAppData": full_app_data})


def post_order(chain_id: int, order: dict) -> str:
    res = _http("POST", f"{orderbook_url(chain_id)}/api/v1/orders", body=order)
    if isinstance(res, str):
        return res
    uid = res.get("uid") or res.get("orderUid") or res
    if not isinstance(uid, str) or not uid.startswith("0x"):
        raise RuntimeError(f"unexpected POST /orders response (no order uid): {json.dumps(res)[:300]}")
    return uid


def enroll_wallet(wallet: str) -> None:
    """Best-effort enroll so the rebate indexer tracks this wallet. Never raises."""
    if not re.match(r"^0x[0-9a-fA-F]{40}$", wallet or ""):
        return
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- fixed https REBATE_INDEXER_URL + a validated 0x-address path segment.
        with urllib.request.urlopen(urllib.request.Request(f"{REBATE_INDEXER_URL}/tier/{wallet}"), timeout=15) as r:
            r.read()
    except Exception:  # noqa: BLE001 — enrollment is best-effort; never block a swap on it.
        pass
