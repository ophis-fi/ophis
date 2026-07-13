"""Ophis (CoW Protocol) order primitives + minimal JSON-RPC for the Swarms tool.

Ophis is CoW Protocol intent settlement: a swap is an OFF-CHAIN EIP-712-signed order,
not an on-chain swap tx. This module builds and submits that order and provides the
small JSON-RPC reads/broadcast the tool needs (decimals, allowance, nonce, gas price,
send raw tx). It does NOT hold keys or sign — the tool signs with eth_account.

Every failure raises (ValueError/RuntimeError) — NEVER sys.exit — because this runs
inside an agent process, not a CLI. Addresses/endpoints mirror @ophis/sdk.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

# ── Per-chain orderbook base URL (@ophis/sdk orderbook.ts). All Ophis chains. ──
ORDERBOOK_URLS = {
    1:     "https://api.cow.fi/mainnet",
    100:   "https://api.cow.fi/xdai",
    137:   "https://api.cow.fi/polygon",
    8453:  "https://api.cow.fi/base",
    42161: "https://api.cow.fi/arbitrum_one",
    43114: "https://api.cow.fi/avalanche",
    56:    "https://api.cow.fi/bnb",
    59144: "https://api.cow.fi/linea",
    57073: "https://api.cow.fi/ink",
    10:    "https://optimism-mainnet.ophis.fi",   # Ophis-sovereign
    130:   "https://unichain-mainnet.ophis.fi",   # Ophis-sovereign
}

# Public RPCs for eth_call reads (decimals/allowance/nonce/gas) + eth_sendRawTransaction.
RPC_URLS = {
    1:     "https://ethereum-rpc.publicnode.com",
    10:    "https://mainnet.optimism.io",
    56:    "https://bsc-dataseed.binance.org",
    100:   "https://rpc.gnosischain.com",
    130:   "https://mainnet.unichain.org",
    137:   "https://polygon-rpc.com",
    8453:  "https://mainnet.base.org",
    42161: "https://arb1.arbitrum.io/rpc",
    43114: "https://api.avax.network/ext/bc/C/rpc",
    57073: "https://rpc-gel.inkonchain.com",
    59144: "https://rpc.linea.build",
}

# ── Settlement (EIP-712 verifyingContract) + VaultRelayer (approve spender) ────
_CANONICAL_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"
_CANONICAL_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110"
_SETTLEMENT = {
    10:  "0x310784c7FCE12d578dA6f53460777bAc9718B859",
    130: "0x108A678716e5E1776036eF044CAB7064226F714E",
}
_VAULT_RELAYER = {
    10:  "0x83847EaB41ad9ea43809ce71569eB2e9daF51830",
    130: "0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb",
}

# ── Ophis partner fee (partner-fee.ts). Fee rides in appData; order feeAmount is 0. ─
OPHIS_PARTNER_FEE_RECIPIENT = "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"  # Ophis Safe
OPHIS_VOLUME_FEE_BPS = 5
OPHIS_STABLE_VOLUME_FEE_BPS = 1
APP_DATA_VERSION = "1.4.0"
MAX_UINT256 = (1 << 256) - 1
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
CHAIN_ALIASES = {
    "ethereum": 1, "mainnet": 1, "eth": 1, "gnosis": 100, "xdai": 100,
    "polygon": 137, "matic": 137, "base": 8453, "arbitrum": 42161, "arb": 42161,
    "avalanche": 43114, "avax": 43114, "bnb": 56, "bsc": 56, "binance": 56,
    "linea": 59144, "ink": 57073, "optimism": 10, "op": 10, "unichain": 130,
}


def resolve_chain(chain) -> int:
    """Accept a chain id (int/str) or a name alias -> chain id."""
    if isinstance(chain, int):
        cid = chain
    else:
        s = str(chain).strip().lower()
        cid = CHAIN_ALIASES.get(s, int(s) if s.isdigit() else None)
    if cid not in ORDERBOOK_URLS:
        raise ValueError(f"unsupported chain {chain!r}. Supported: {sorted(CHAIN_ALIASES)}")
    return cid


def orderbook_url(chain_id: int) -> str:
    url = ORDERBOOK_URLS.get(int(chain_id))
    if not url:
        raise ValueError(f"chain {chain_id} has no Ophis orderbook. Supported: {sorted(ORDERBOOK_URLS)}")
    return url


def settlement_address(chain_id: int) -> str:
    return _SETTLEMENT.get(int(chain_id), _CANONICAL_SETTLEMENT)


def vault_relayer(chain_id: int) -> str:
    return _VAULT_RELAYER.get(int(chain_id), _CANONICAL_VAULT_RELAYER)


def build_order_typed_data(chain_id: int, order: dict) -> dict:
    """Full EIP-712 typed data to sign for a GPv2/Ophis order. `order["appData"]`
    MUST be the bytes32 appDataHash (not the full JSON string)."""
    return {
        "types": {"EIP712Domain": _EIP712_DOMAIN_TYPE, **GPV2_ORDER_TYPES},
        "primaryType": "Order",
        "domain": {
            "name": "Gnosis Protocol",
            "version": "v2",
            "chainId": int(chain_id),
            "verifyingContract": settlement_address(chain_id),
        },
        "message": order,
    }


def keccak256(data: bytes) -> bytes:
    from eth_utils import keccak as _keccak  # eth-utils is a transitive dep of eth-account

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
    """Whole units -> base units, EXACTLY (pure integer math). Rejects excess precision
    instead of rounding a fraction the token can't represent (e.g. 0.5 of a 0-decimal)."""
    s = str(amount_human).strip()
    m = re.match(r"^(\d+)(?:\.(\d+))?$", s)
    if not m:
        raise ValueError(f'amount must be a plain decimal (e.g. "1.5"): {amount_human!r}')
    frac = (m.group(2) or "").rstrip("0")
    if len(frac) > decimals:
        raise ValueError(f'amount "{amount_human}" needs {len(frac)} decimals but the token supports only {decimals}.')
    atomic = int(m.group(1) + frac.ljust(decimals, "0"))
    if atomic <= 0:
        raise ValueError(f"amount must be > 0: {amount_human!r}")
    return atomic


def encode_approve(spender: str, amount: int) -> str:
    """approve(address,uint256) — selector 0x095ea7b3."""
    return "0x095ea7b3" + spender.lower().replace("0x", "").rjust(64, "0") + format(amount, "x").rjust(64, "0")


def _http(method: str, url: str, body: dict | None = None, timeout: int = 60) -> dict:
    if not url.lower().startswith("https://"):
        raise ValueError(f"refusing non-HTTPS URL: {url}")  # block file://, http://, etc.
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- URL is scheme-guarded to https:// and built from the fixed ORDERBOOK_URLS/RPC_URLS https maps.
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url} -> HTTP {e.code}: {e.read().decode(errors='replace')[:500]}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"{method} {url} -> network error: {e}") from e


# ── Ophis / CoW orderbook REST ────────────────────────────────────────────────
def get_quote(chain_id, sell_token, buy_token, sell_amount_atomic, from_addr, app_data_hash) -> dict:
    # Send the appData HASH (not the full string) to the quote — CoW's strict app-data
    # schema (additionalProperties:false) rejects the Ophis-only `ophisReferrer` key.
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
    except Exception:  # noqa: BLE001 — enrollment is best-effort; never block a swap.
        pass


# ── Minimal JSON-RPC (reads + broadcast). No web3 dependency. ──────────────────
def _rpc(chain_id: int, method: str, params: list, timeout: int = 30):
    rpc = RPC_URLS.get(int(chain_id))
    if not rpc:
        raise RuntimeError(f"no RPC configured for chain {chain_id}")
    res = _http("POST", rpc, body={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=timeout)
    if isinstance(res, dict) and res.get("error"):
        raise RuntimeError(f"RPC {method} error: {json.dumps(res['error'])[:300]}")
    return res.get("result") if isinstance(res, dict) else None


def _rpc_int(chain_id: int, method: str, params: list) -> int:
    val = _rpc(chain_id, method, params)
    if not (isinstance(val, str) and val.startswith("0x")):
        raise RuntimeError(f"RPC {method} returned a non-hex result: {val!r}")
    return int(val, 16)


def read_decimals(chain_id: int, token: str) -> int:
    val = _rpc(chain_id, "eth_call", [{"to": token, "data": "0x313ce567"}, "latest"])  # decimals()
    if not (isinstance(val, str) and val.startswith("0x") and len(val) > 2):
        raise RuntimeError(f"could not read decimals for {token} on chain {chain_id}")
    d = int(val, 16)
    if d > 36:
        raise RuntimeError(f"implausible token decimals {d} for {token}")
    return d


def read_allowance(chain_id: int, token: str, owner: str, spender: str) -> int:
    data = ("0xdd62ed3e" + owner.lower().replace("0x", "").rjust(64, "0")
            + spender.lower().replace("0x", "").rjust(64, "0"))  # allowance(address,address)
    val = _rpc(chain_id, "eth_call", [{"to": token, "data": data}, "latest"])
    # Do NOT fail open to 0: a malformed read must abort, not silently trigger an approve
    # (a nonzero->nonzero USDT approve would then revert). Better to stop than guess.
    if not (isinstance(val, str) and val.startswith("0x") and len(val) > 2):
        raise RuntimeError(f"could not read allowance for {token} on chain {chain_id}: {val!r}")
    return int(val, 16)


def get_nonce(chain_id: int, owner: str) -> int:
    return _rpc_int(chain_id, "eth_getTransactionCount", [owner, "pending"])


def get_gas_price(chain_id: int) -> int:
    return _rpc_int(chain_id, "eth_gasPrice", [])


def estimate_gas(chain_id: int, tx: dict) -> int:
    return _rpc_int(chain_id, "eth_estimateGas", [tx])


def send_raw_transaction(chain_id: int, raw_hex: str) -> str:
    tx_hash = _rpc(chain_id, "eth_sendRawTransaction", [raw_hex])
    if not (isinstance(tx_hash, str) and tx_hash.startswith("0x")):
        raise RuntimeError(f"eth_sendRawTransaction returned no hash: {tx_hash!r}")
    return tx_hash


def get_transaction_receipt(chain_id: int, tx_hash: str):
    """eth_getTransactionReceipt -> receipt dict (once mined) or None (still pending)."""
    return _rpc(chain_id, "eth_getTransactionReceipt", [tx_hash])
