"""Shared helpers for the Ophis MetaMask Agent Wallet skill: chain maps, appData,
the GPv2 order + its EIP-712 typed-data, ABI encoding, the Ophis/CoW orderbook, and
the MetaMask `mm` CLI (address / send-transaction / sign-typed-data).

Ophis is CoW Protocol intent settlement: a swap is an OFF-CHAIN EIP-712-signed order,
not a normal swap tx. From a MetaMask Agent Wallet we authorize the order with a REAL
EIP-712 signature (`mm wallet sign-typed-data`) — not presign — and send the ERC-20
approval with `mm wallet send-transaction`. Addresses/endpoints from @ophis/sdk.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.request
import urllib.error

# ── Per-chain orderbook base URL (@ophis/sdk orderbook.ts) ────────────────────
ORDERBOOK_URLS = {
    1:        "https://api.cow.fi/mainnet",
    100:      "https://api.cow.fi/xdai",
    137:      "https://api.cow.fi/polygon",
    8453:     "https://api.cow.fi/base",
    42161:    "https://api.cow.fi/arbitrum_one",
    43114:    "https://api.cow.fi/avalanche",
    56:       "https://api.cow.fi/bnb",
    9745:     "https://api.cow.fi/plasma",
    59144:    "https://api.cow.fi/linea",
    57073:    "https://api.cow.fi/ink",
    10:       "https://optimism-mainnet.ophis.fi",   # Ophis-sovereign
    130:      "https://unichain-mainnet.ophis.fi",   # Ophis-sovereign
}

# Public RPCs — used only for a BEST-EFFORT allowance read (skip a redundant approve).
# The swap still works if a read fails; it just can't skip an already-sufficient approval.
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
    9745:  "https://rpc.plasma.to",
    57073: "https://rpc-gel.inkonchain.com",
    59144: "https://rpc.linea.build",
}

# ── Settlement (EIP-712 verifyingContract) + VaultRelayer (approve spender) ────
_CANONICAL_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"
_CANONICAL_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110"
SETTLEMENT = {
    10:  "0x310784c7FCE12d578dA6f53460777bAc9718B859",
    130: "0x108A678716e5E1776036eF044CAB7064226F714E",
}
VAULT_RELAYER = {
    10:  "0x83847EaB41ad9ea43809ce71569eB2e9daF51830",
    130: "0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb",
}

# ── Ophis partner fee (partner-fee.ts) ────────────────────────────────────────
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


def orderbook_url(chain_id: int) -> str:
    url = ORDERBOOK_URLS.get(chain_id)
    if not url:
        sys.exit(f"chain {chain_id} has no Ophis orderbook (unsupported/paused). Supported: {sorted(ORDERBOOK_URLS)}")
    return url


def settlement_address(chain_id: int) -> str:
    return SETTLEMENT.get(chain_id, _CANONICAL_SETTLEMENT)


def vault_relayer(chain_id: int) -> str:
    return VAULT_RELAYER.get(chain_id, _CANONICAL_RELAYER)


def build_order_typed_data(chain_id: int, order: dict) -> dict:
    """The full EIP-712 typed data to sign for a GPv2/Ophis order. The order's
    `appData` field MUST be the bytes32 appDataHash (not the full JSON string)."""
    return {
        "types": {"EIP712Domain": _EIP712_DOMAIN_TYPE, **GPV2_ORDER_TYPES},
        "primaryType": "Order",
        "domain": {
            "name": "Gnosis Protocol",
            "version": "v2",
            "chainId": chain_id,
            "verifyingContract": settlement_address(chain_id),
        },
        "message": order,
    }


# ── keccak256 (appDataHash) ───────────────────────────────────────────────────
def keccak256(data: bytes) -> bytes:
    try:
        import sha3
        h = sha3.keccak_256(); h.update(data); return h.digest()
    except Exception:
        pass
    try:
        from Crypto.Hash import keccak
        h = keccak.new(digest_bits=256); h.update(data); return h.digest()
    except Exception:
        pass
    try:
        from eth_hash.auto import keccak as ek
        return ek(data)
    except Exception:
        pass
    sys.exit("No keccak256 backend. Install one: pip install pysha3  (or pycryptodome, or 'eth-hash[pycryptodome]')")


# ── Ophis appData ─────────────────────────────────────────────────────────────
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
            sys.exit(f"invalid referral code {referral_code!r}: must match [a-z0-9_-]{{3,64}}")
        metadata["ophisReferrer"] = {"code": code}
    doc = {"appCode": "ophis", "metadata": metadata, "version": APP_DATA_VERSION}
    full = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    return full, "0x" + keccak256(full.encode("utf-8")).hex()


# ── Minimal ABI encoding (no web3) ────────────────────────────────────────────
def encode_approve(spender: str, amount: int) -> str:
    """approve(address,uint256) — selector 0x095ea7b3."""
    return "0x095ea7b3" + spender.lower().replace("0x", "").rjust(64, "0") + format(amount, "x").rjust(64, "0")


def to_atomic(amount_human: str, decimals: int) -> int:
    """Whole units -> base units, EXACTLY (pure integer math — no Decimal rounding).
    Rejects excess precision instead of truncating/rounding a fraction the token can't
    represent (e.g. 0.5 of a 0-decimal token)."""
    s = amount_human.strip()
    m = re.match(r"^(\d+)(?:\.(\d+))?$", s)
    if not m:
        sys.exit(f'amount must be a plain decimal (e.g. "1.5"): {amount_human!r}')
    frac = (m.group(2) or "").rstrip("0")  # trailing zeros carry no precision
    if len(frac) > decimals:
        sys.exit(f'amount "{amount_human}" needs {len(frac)} decimals but the token supports only {decimals}.')
    atomic = int(m.group(1) + frac.ljust(decimals, "0"))
    if atomic <= 0:
        sys.exit(f"amount must be > 0: {amount_human!r}")
    return atomic


# ── HTTP + Ophis/CoW orderbook ────────────────────────────────────────────────
def _http(method: str, url: str, body: dict | None = None, headers: dict | None = None, timeout: int = 60) -> dict:
    if not url.lower().startswith("https://"):
        sys.exit(f"refusing non-HTTPS URL: {url}")  # block file://, http://, etc.
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- URL is scheme-guarded to https:// above and built from the fixed ORDERBOOK_URLS/RPC_URLS https map.
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} -> HTTP {e.code}: {e.read().decode(errors='replace')[:500]}")
    except (urllib.error.URLError, TimeoutError) as e:
        sys.exit(f"{method} {url} -> network error: {e}")


def get_quote(chain_id, sell_token, buy_token, sell_amount_atomic, from_addr, full_app_data, app_data_hash) -> dict:
    # Send the appData HASH (not the full string) to the quote — CoW's strict app-data
    # schema (additionalProperties:false) rejects the Ophis-only `ophisReferrer` key,
    # so an inline full doc can 400 a referral'd quote. The full string is only PUT +
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
        sys.exit(f"unexpected POST /orders response (no order uid): {json.dumps(res)[:300]}")
    return uid


def read_allowance(chain_id: int, token: str, owner: str, spender: str):
    """Best-effort ERC-20 allowance(owner, spender) via eth_call. Returns int, or None
    if the read fails (the caller then approves without the skip optimization)."""
    rpc = RPC_URLS.get(chain_id)
    if not rpc:
        return None
    data = ("0xdd62ed3e" + owner.lower().replace("0x", "").rjust(64, "0")
            + spender.lower().replace("0x", "").rjust(64, "0"))  # allowance(address,address)
    try:
        res = _http("POST", rpc, body={"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                                       "params": [{"to": token, "data": data}, "latest"]}, timeout=20)
    except SystemExit:
        return None
    val = res.get("result") if isinstance(res, dict) else None
    if isinstance(val, str) and val.startswith("0x") and len(val) > 2:
        try:
            return int(val, 16)
        except ValueError:
            return None
    return None


def enroll_wallet(wallet: str) -> None:
    """Best-effort enroll so the rebate indexer tracks this wallet. Never blocks."""
    if not re.match(r"^0x[0-9a-fA-F]{40}$", wallet):
        return
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- fixed https REBATE_INDEXER_URL + a validated 0x-address path segment.
        with urllib.request.urlopen(urllib.request.Request(f"{REBATE_INDEXER_URL}/tier/{wallet}"), timeout=15) as r:
            r.read()
    except Exception:
        # Best-effort + non-blocking by design: a rebate-indexer outage (DNS/connection/timeout/
        # non-2xx) must NOT abort the swap. Enrollment is idempotent and retried on the next swap,
        # so every failure mode is swallowed here and the healthy swap + fee path still proceeds.
        pass


# ── MetaMask Agent Wallet `mm` CLI ────────────────────────────────────────────
# Verified surface (@metamask/agentic-cli). Result-returning commands MUST pass --wait
# (else a pollingId, not the result). --json field names are undocumented, so we probe
# likely keys + fall back to an EXACT-length 0x regex per value type.
def _mm(args, timeout: int = 240, soft: bool = False):
    cmd = ["mm", *args]
    if "--json" not in args:
        cmd.append("--json")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        if soft:
            return None
        sys.exit("`mm` (MetaMask Agent Wallet CLI) not found. Install: npm i -g @metamask/agentic-cli")
    except subprocess.TimeoutExpired:
        if soft:
            return None
        sys.exit(f"`mm {' '.join(args[:2])} …` timed out after {timeout}s")
    if proc.returncode != 0:
        if soft:
            return None
        sys.exit(f"`mm {' '.join(args[:2])} …` failed (exit {proc.returncode}): {(proc.stderr or proc.stdout).strip()[:400]}")
    out = (proc.stdout or "").strip()
    try:
        return json.loads(out)
    except Exception:
        return out


def _extract_0x(res, keys, regex: str, label: str) -> str:
    pat = re.compile(regex)
    if isinstance(res, dict):
        for container in (res, res.get("data") or {}, res.get("result") or {}):
            if isinstance(container, dict):
                for k in keys:
                    v = container.get(k)
                    if isinstance(v, str) and pat.fullmatch(v):  # EXACT length — an address can't pass as a signature
                        return v
    text = res if isinstance(res, str) else json.dumps(res)
    m = re.search(regex, text)
    if m:
        return m.group(0)
    sys.exit(f"could not parse the {label} from `mm` output — verify the CLI's JSON shape. Got: {str(res)[:300]}")


def mm_require_ready() -> None:
    # Best-effort gate: only HARD-block when the CLI clearly reports not-ready. If
    # `mm doctor` output can't be parsed (older build / no --json), proceed — the
    # sign/tx call will fail with a clear mm error if the wallet really isn't set up.
    d = _mm(["doctor"], soft=True)
    if isinstance(d, dict) and d.get("authenticated") is not None and not (d.get("authenticated") and d.get("initialized")):
        sys.exit("MetaMask Agent Wallet not ready — run `mm login` and `mm init`, then `mm doctor` (needs authenticated + initialized).")


def mm_wallet_address() -> str:
    return _extract_0x(_mm(["wallet", "address", "--chain-namespace", "evm"]),
                       ("address", "walletAddress", "value"), r"0x[a-fA-F0-9]{40}(?![a-fA-F0-9])", "wallet address")


def mm_send_transaction(chain_id: int, to: str, data: str, intent: str, timeout: int = 300) -> str:
    # `intent` is a human-readable description kept in the signature; it is NOT passed as a CLI flag.
    # The documented `mm wallet` surface (--chain-id/--payload/--wait) does not include --intent, and
    # an unknown flag would make the CLI reject the command.
    del intent
    payload = json.dumps({"to": to, "value": "0x0", "data": data})
    res = _mm(["wallet", "send-transaction", "--chain-id", str(chain_id), "--payload", payload, "--wait"], timeout=timeout)
    return _extract_0x(res, ("transactionHash", "txHash", "hash"), r"0x[a-fA-F0-9]{64}(?![a-fA-F0-9])", "transaction hash")


def mm_sign_typed_data(chain_id: int, typed_data: dict, intent: str) -> str:
    del intent  # see mm_send_transaction: --intent is not a supported mm flag; keep it out of the cmd.
    payload = json.dumps(typed_data)
    res = _mm(["wallet", "sign-typed-data", "--chain-id", str(chain_id), "--payload", payload, "--wait"])
    # An EOA EIP-712 signature is exactly 65 bytes = 130 hex chars (0x + 130). Exact
    # length prevents a 40-hex address or 64-hex hash/pollingId being taken as the sig.
    return _extract_0x(res, ("signature", "sig", "result"), r"0x[a-fA-F0-9]{130}(?![a-fA-F0-9])", "signature")
