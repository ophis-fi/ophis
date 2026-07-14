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
import urllib.error
import urllib.request

# ── Per-chain orderbook base URL (@ophis/sdk orderbook.ts). Only the chains that
# also exist in Wayfinder's SUPPORTED_CHAINS are reachable from this adapter; the
# adapter enforces that intersection (Optimism/Unichain/Gnosis/Linea/Ink are Ophis
# chains that Wayfinder does not support, so they are intentionally absent here).
# Plasma (9745) IS in both — Ophis (canonical CoW deployment) and the Wayfinder SDK. ─
ORDERBOOK_URLS = {
    1:     "https://api.cow.fi/mainnet",
    56:    "https://api.cow.fi/bnb",
    137:   "https://api.cow.fi/polygon",
    8453:  "https://api.cow.fi/base",
    9745:  "https://api.cow.fi/plasma",
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


# ── Stable-pair fee tier: DERIVED from a verified stablecoin registry (NOT caller input) ──
# AUTO-DERIVED from the Ophis frontend STABLECOINS (apps/frontend/libs/common-const/src/tokens.ts),
# the same verified source swap.ophis.fi uses for the 1bp stable-pair tier. Lowercased.
# Conservative: a pair not in a chain's set gets the standard rate (never undercharges).
STABLECOINS = {
    1: {"0x056fd409e1d7a124bd7017459dfea2f387b6d5cd", "0x39b8b6385416f4ca36a20319f70d28621895279d", "0x57ab1ec28d129707052df4df418d58a2d46d5f51", "0x6b175474e89094c44da98b954eedeac495271d0f", "0x6c3ea9036406852006290770bedfcaba0e23a0e8", "0x853d955acef822db058eb8505911ed77f175b99e", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"},
    10: {"0x0b2c639c533813f4aa9d7837caf62653d097ff85", "0x7f5c764cbc14f9669b88837ca1490cca17c31607", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1"},
    56: {"0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3", "0x55d398326f99059ff775485246999027b3197955", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "0xe9e7cea3dedca5984780bafc599bd69add087d56"},
    100: {"0x2a22f9c3b484c3629090feed35f17ff8f88f76f0", "0x4ecaba5870353805a9f068101a40e0f32ed605c6", "0x5cb9073902f2035222b9749f8fb0c9bfe5527108", "0xaf204776c7245bf4147c2612bf6e5972ee483701", "0xcb444e90d8198415266c6a2724b7900fb12fc56e", "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83", "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d"},
    130: {"0x078d782b760474a361dda0af3839290b0ef57ad6"},
    137: {"0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", "0xe0aea583266584dafbb3f9c3211d5588c73fea8d"},
    8453: {"0x04d5ddf5f3a8939889f11e97f8c4bb48317f1938", "0x4621b7a9c75199271f773ebd9a499dbd165c3191", "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xb79dd08ea68a908a97220c76d19a6aa9cbde4376", "0xbf6e2966a9c3d99c9e4d069e04f7bdb9c8aa762c", "0xca72827a3d211cfd8f6b00ac98824872b72cab49", "0xcfa3ef56d303ae4faaba0592388f19d7c3399fb4", "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"},
    9745: {"0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb"},
    42161: {"0x0c06ccf38114ddfc35e07427b9424adcca9f44f8", "0x17fc002b466eec40dae837fc4be5c67993ddbd6f", "0x59d9356e565ab3a36dd77763fc0d87feaf85508c", "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "0xfea7a6a0b346362bf88a9e4a88416b77a57d6c2a", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"},
    43114: {"0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"},
    57073: {"0x0200c29006150606b650577bbe7b6248f58470c1", "0x2d270e6886d130d724215a266106e6832161eaed", "0xf1815bd50389c46847f0bda824ec8da914045d14"},
    59144: {"0x176211869ca2b568f2a7d4ee941e073a821ee1ff", "0x3ff47c5bf409c86533fe1f4907524d304062428d"},
    11155111: {"0x58eb19ef91e8a6327fed391b51ae1887b833cc91", "0xbe72e441bf55620febc26715db68d3494213d8cb"},
}

def is_stable_pair(chain_id, sell_token, buy_token) -> bool:
    s = STABLECOINS.get(int(chain_id))
    if not s:
        return False
    return sell_token.lower() in s and buy_token.lower() in s
