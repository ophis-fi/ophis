"""Shared helpers for the Ophis Bankr skill: chain maps, appData, ABI encoding,
Ophis/CoW orderbook calls, and the Bankr Submit API.

All endpoint URLs and contract addresses below are taken from @ophis/sdk
(packages/sdk/src/{orderbook,domain,partner-fee,flow}.ts). See references/api.md
for the source-of-truth citations.

Ophis is CoW Protocol intent settlement: a swap is an OFF-CHAIN signed order, not
a normal swap tx. From a Bankr-managed wallet we authorize the order with the
`presign` scheme — POST the order, then send an on-chain setPreSignature(uid,true)
to the Settlement contract via the Bankr Submit API — so no raw message-signing is
needed (a clean fit for Bankr's transaction-submission model).
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import urllib.request
import urllib.error

# ── Per-chain orderbook base URL (OPHIS_ORDERBOOK_URLS, orderbook.ts) ──────────
# CoW-hosted chains hit api.cow.fi/<slug>; OP + Unichain hit the Ophis self-hosted
# orderbook (hitting api.cow.fi there silently bypasses the Ophis solver + fee).
ORDERBOOK_URLS = {
    1:        "https://api.cow.fi/mainnet",
    100:      "https://api.cow.fi/xdai",
    137:      "https://api.cow.fi/polygon",
    8453:     "https://api.cow.fi/base",
    42161:    "https://api.cow.fi/arbitrum_one",
    43114:    "https://api.cow.fi/avalanche",
    56:       "https://api.cow.fi/bnb",
    59144:    "https://api.cow.fi/linea",
    9745:     "https://api.cow.fi/plasma",
    57073:    "https://api.cow.fi/ink",
    11155111: "https://api.cow.fi/sepolia",
    10:       "https://optimism-mainnet.ophis.fi",   # Ophis-sovereign
    130:      "https://unichain-mainnet.ophis.fi",   # Ophis-sovereign
}

# Public RPCs for a BEST-EFFORT allowance read (skip a redundant approve + drive the USDT-safe
# reset). The swap still works if a read fails; it just can't optimize the approval.
RPC_URLS = {
    1:        "https://ethereum-rpc.publicnode.com",
    10:       "https://mainnet.optimism.io",
    56:       "https://bsc-dataseed.binance.org",
    100:      "https://rpc.gnosischain.com",
    130:      "https://mainnet.unichain.org",
    137:      "https://polygon-rpc.com",
    8453:     "https://mainnet.base.org",
    9745:     "https://rpc.plasma.to",
    42161:    "https://arb1.arbitrum.io/rpc",
    43114:    "https://api.avax.network/ext/bc/C/rpc",
    57073:    "https://rpc-gel.inkonchain.com",
    59144:    "https://rpc.linea.build",
    11155111: "https://ethereum-sepolia-rpc.publicnode.com",
}

# ── Settlement (setPreSignature target) + VaultRelayer (approve spender) ───────
# domain.ts. Canonical CoW addresses on hosted chains; NON-canonical on OP/Unichain
# (using the canonical addresses there makes the order/signature silently invalid).
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
OPHIS_VOLUME_FEE_BPS = 5          # integrator/partner rate
OPHIS_STABLE_VOLUME_FEE_BPS = 1   # stable-stable pair rate
APP_DATA_VERSION = "1.4.0"

REBATE_INDEXER_URL = "https://rebates.ophis.fi"
BANKR_API = "https://api.bankr.bot"


def orderbook_url(chain_id: int) -> str:
    url = ORDERBOOK_URLS.get(chain_id)
    if not url:
        sys.exit(
            f"chain {chain_id} has no Ophis orderbook (unsupported or paused). "
            f"Supported: {sorted(ORDERBOOK_URLS)}"
        )
    return url


def settlement_address(chain_id: int) -> str:
    return SETTLEMENT.get(chain_id, _CANONICAL_SETTLEMENT)


def vault_relayer(chain_id: int) -> str:
    return VAULT_RELAYER.get(chain_id, _CANONICAL_RELAYER)


# ── keccak256 (needed for appDataHash + the setPreSignature selector) ──────────
# hashlib.sha3_256 is NOT keccak256 (different padding), so we need a keccak lib.
def keccak256(data: bytes) -> bytes:
    try:
        import sha3  # pysha3
        h = sha3.keccak_256()
        h.update(data)
        return h.digest()
    except Exception:
        pass
    try:
        from Crypto.Hash import keccak  # pycryptodome
        h = keccak.new(digest_bits=256)
        h.update(data)
        return h.digest()
    except Exception:
        pass
    try:
        from eth_hash.auto import keccak as ek  # eth-hash
        return ek(data)
    except Exception:
        pass
    sys.exit(
        "No keccak256 backend found. Install one:\n"
        "  pip install pysha3        # or\n"
        "  pip install pycryptodome  # or\n"
        "  pip install 'eth-hash[pycryptodome]'"
    )


# ── Ophis appData (flow.ts / partner-fee.ts / referral.ts) ────────────────────
def build_app_data(referral_code: str | None = None, is_stable_pair: bool = False):
    """Return (full_app_data_string, app_data_hash_0x).

    appCode MUST be the literal 'ophis' or the rebate indexer silently drops the
    order. partnerFee is the CIP-75 VOLUME shape {volumeBps, recipient}. The pair
    is signed with appData=hash but SUBMITTED with appData=full string + a separate
    appDataHash; the backend checks keccak256(full) == hash, so the two are always
    self-consistent here regardless of key ordering.
    """
    metadata = {
        "partnerFee": {
            "volumeBps": OPHIS_STABLE_VOLUME_FEE_BPS if is_stable_pair else OPHIS_VOLUME_FEE_BPS,
            "recipient": OPHIS_PARTNER_FEE_RECIPIENT,
        },
        "hooks": {},
    }
    if referral_code:
        # Validate against the SDK grammar /^[a-z0-9_-]{3,64}$/ (referral.ts) and FAIL
        # LOUDLY on a bad code — an unmatchable code would be silently written to
        # appData, so the order settles but the referrer earns NO rebate (silent
        # unattribution). Optional: omitting the code still yields a valid fee-bearing
        # order, you just forgo the rebate.
        code = referral_code.strip().lower()
        if not re.match(r"^[a-z0-9_-]{3,64}$", code):
            sys.exit(f"invalid referral code {referral_code!r}: must match [a-z0-9_-]{{3,64}}")
        metadata["ophisReferrer"] = {"code": code}
    doc = {"appCode": "ophis", "metadata": metadata, "version": APP_DATA_VERSION}
    # Deterministic compact JSON (sorted keys), matching cow-sdk's stringify.
    full = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    app_hash = "0x" + keccak256(full.encode("utf-8")).hex()
    return full, app_hash


# ── Minimal ABI encoding (no web3 dependency) ─────────────────────────────────
def _pad(hex_no0x: str) -> str:
    return hex_no0x.rjust(64, "0")


def encode_approve(spender: str, amount: int) -> str:
    """approve(address,uint256) — selector 0x095ea7b3."""
    return "0x095ea7b3" + _pad(spender.lower().replace("0x", "")) + _pad(format(amount, "x"))


def encode_set_presignature(order_uid_hex: str, signed: bool = True) -> str:
    """setPreSignature(bytes orderUid, bool signed).

    orderUid is a dynamic `bytes` (56 bytes for a CoW order UID), so the head is
    [offset=0x40, bool] and the tail is [length, data-padded-to-32].
    """
    selector = keccak256(b"setPreSignature(bytes,bool)")[:4].hex()
    uid = order_uid_hex.lower().replace("0x", "")
    length = len(uid) // 2
    padded_data = uid + "0" * ((64 - (len(uid) % 64)) % 64)
    return (
        "0x" + selector
        + _pad(format(64, "x"))               # offset to the bytes arg (0x40)
        + _pad("1" if signed else "0")        # bool signed
        + _pad(format(length, "x"))           # bytes length (56)
        + padded_data                          # uid, right-padded to 32
    )


# ── HTTP + Bankr Submit API ───────────────────────────────────────────────────
def _http(method: str, url: str, body: dict | None = None, headers: dict | None = None,
          timeout: int = 60) -> dict:
    if not url.lower().startswith("https://"):
        sys.exit(f"refusing non-HTTPS URL: {url}")  # block file://, http://, etc.
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- URL is scheme-guarded to https:// above and built from the fixed ORDERBOOK_URLS/BANKR_API https maps.
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        sys.exit(f"{method} {url} -> HTTP {e.code}: {detail[:500]}")
    except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
        # A DNS/connection/timeout failure must exit cleanly, not dump a traceback.
        sys.exit(f"{method} {url} -> network error: {e}")
    # Single explicit return: the except branches sys.exit (NoReturn), so this is the only
    # non-error path — no implicit fall-through to None for a function typed -> dict.
    return json.loads(raw) if raw else {}


def read_allowance(chain_id: int, token: str, owner: str, spender: str):
    """Best-effort ERC-20 allowance(owner, spender) via a public-RPC eth_call. Returns int, or
    None if unreadable (no RPC / network / malformed) — the caller then does the USDT-safe
    reset-then-approve rather than risk a nonzero->nonzero approve that reverts. Never raises."""
    rpc = RPC_URLS.get(int(chain_id))
    if not rpc or not rpc.lower().startswith("https://"):
        return None
    data = ("0xdd62ed3e" + owner.lower().replace("0x", "").rjust(64, "0")
            + spender.lower().replace("0x", "").rjust(64, "0"))  # allowance(address,address)
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": token, "data": data}, "latest"]}).encode()
    try:
        req = urllib.request.Request(rpc, data=body, method="POST")
        req.add_header("content-type", "application/json")
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- rpc is scheme-guarded to https:// and taken from the fixed RPC_URLS map; calldata is a fixed selector + validated address args.
        with urllib.request.urlopen(req, timeout=20) as resp:
            res = json.loads(resp.read().decode())
        val = res.get("result") if isinstance(res, dict) else None
        return int(val, 16) if isinstance(val, str) and val.startswith("0x") and len(val) > 2 else None
    except Exception:  # noqa: BLE001 — best-effort optimization; any failure falls back to reset+approve.
        return None


def bankr_api_key() -> str:
    key = os.environ.get("BANKR_API_KEY")
    if not key:
        cfg = os.path.expanduser("~/.bankr/config.json")
        if os.path.exists(cfg):
            with open(cfg) as f:
                key = json.load(f).get("apiKey")
    if not key:
        sys.exit("Set BANKR_API_KEY (or configure ~/.bankr/config.json). Get a key at bankr.bot/api-keys.")
    return key


_EVM_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def bankr_wallet_address(key: str) -> str:
    # GET /wallet/me returns the wallet info (address + chains). The legacy /agent/* endpoints
    # were removed; the Wallet API is the current surface. Resolve the EVM address by FORMAT,
    # not by guessing one exact key: Bankr is multi-chain (EVM + Solana) and a Solana address is
    # never 0x-40-hex, so a format guard can never return one.
    res = _http("GET", f"{BANKR_API}/wallet/me", headers={"X-API-Key": key})

    def _named(d):
        # Prefer an explicitly wallet-named key, so a stray token/contract 0x can't win.
        if not isinstance(d, dict):
            return None
        for k in ("evmAddress", "address", "evm", "wallet", "walletAddress", "signer", "owner"):
            v = d.get(k)
            if isinstance(v, str) and _EVM_ADDR_RE.match(v):
                return v
        return None

    addr = None
    if isinstance(res, dict):  # a non-object JSON response falls through to the clean error below
        addr = _named(res)
        for nest in ("data", "wallet", "addresses", "evm"):  # tolerate one level of nesting
            addr = addr or _named(res.get(nest))
        if not addr:
            # Last resort: any top-level 0x EVM value. /wallet/me is wallet info (address + chains),
            # not a token list, so a bare format-guarded scan is safe.
            addr = next((v for v in res.values() if isinstance(v, str) and _EVM_ADDR_RE.match(v)), None)
    if not addr:
        sys.exit(f"could not resolve the Bankr EVM wallet address from /wallet/me: {json.dumps(res)[:300]}")
    return addr


def bankr_submit(key: str, chain_id: int, to: str, data: str, description: str, value: str = "0") -> dict:
    # POST /wallet/submit (the current Wallet API; /agent/submit was removed). Same body shape.
    res = _http(
        "POST", f"{BANKR_API}/wallet/submit",
        body={
            "transaction": {"to": to, "chainId": chain_id, "value": value, "data": data},
            "description": description,
            "waitForConfirmation": True,
        },
        headers={"X-API-Key": key},
        timeout=120,  # waitForConfirmation blocks on the tx being mined
    )
    # Documented /wallet/submit status values are "success" | "reverted" | "pending". With
    # waitForConfirmation a mined-but-REVERTED tx still returns a hash, so a hash alone is NOT
    # success (a reverted approval / setPreSignature would otherwise print as a fillable order).
    status = str(res.get("status") or res.get("state") or "").lower()
    if status in ("reverted", "failed", "failure", "error", "dropped"):
        sys.exit(f"Bankr submit reverted/failed ({description}, status={status!r}): {json.dumps(res)[:400]}")
    if status == "pending":
        # Not yet confirmed — refuse regardless of any success flag; an approval/presign this
        # skill submits MUST be mined before we build/print an order that depends on it.
        sys.exit(f"Bankr submit not confirmed ({description}, status=pending): {json.dumps(res)[:400]}")
    has_status_key = ("status" in res) or ("state" in res)
    # Accept an explicit confirmed success; only fall back to a bare hash when the response
    # reports NO status field at all (legacy) — a present-but-empty status is not "confirmed".
    ok = status in ("success", "confirmed", "mined", "ok") or res.get("success") is True \
        or (not has_status_key and bool(res.get("transactionHash")))
    if not ok:
        sys.exit(f"Bankr submit not confirmed successful ({description}): {json.dumps(res)[:400]}")
    return res


# ── Ophis / CoW orderbook ─────────────────────────────────────────────────────
def get_quote(chain_id: int, sell_token: str, buy_token: str, sell_amount_wei: int,
              from_addr: str, full_app_data: str, app_data_hash: str) -> dict:
    base = orderbook_url(chain_id)
    body = {
        "sellToken": sell_token,
        "buyToken": buy_token,
        "from": from_addr,
        "receiver": from_addr,
        "kind": "sell",
        "sellAmountBeforeFee": str(sell_amount_wei),
        "partiallyFillable": False,
        "sellTokenBalance": "erc20",
        "buyTokenBalance": "erc20",
        "priceQuality": "optimal",
        # The order is submitted with signingScheme presign, so quote with the same scheme — CoW
        # treats the requested scheme as part of the returned order shape/UID expectations.
        "signingScheme": "presign",
        "onchainOrder": False,
        # Send the appData HASH (not the full JSON) to the quote: CoW's strict app-data schema
        # rejects the Ophis-only ophisReferrer key, so an inline full doc 400s a referral'd quote.
        # The full string is only PUT + submitted (those paths accept the extension).
        "appData": app_data_hash,
        "appDataHash": app_data_hash,
        "validFor": 1200,
    }
    res = _http("POST", f"{base}/api/v1/quote", body=body)
    quote = res.get("quote") or res
    return quote


def put_app_data(chain_id: int, app_data_hash: str, full_app_data: str) -> None:
    """Upload the full appData so solvers can read the partnerFee for this hash."""
    base = orderbook_url(chain_id)
    _http("PUT", f"{base}/api/v1/app_data/{app_data_hash}", body={"fullAppData": full_app_data})


def post_order(chain_id: int, order: dict) -> str:
    base = orderbook_url(chain_id)
    res = _http("POST", f"{base}/api/v1/orders", body=order)
    # The orderbook returns the order UID as a bare JSON string (or under a key).
    if isinstance(res, str):
        return res
    uid = res.get("uid") or res.get("orderUid") or res
    if not isinstance(uid, str) or not uid.startswith("0x"):
        sys.exit(f"unexpected POST /orders response (no order uid): {json.dumps(res)[:300]}")
    return uid


def enroll_wallet(wallet: str) -> None:
    """Best-effort: register the wallet so the rebate indexer indexes its trades.
    Idempotent GET /tier/{wallet}. MUST NOT block or abort the swap — a rebate-
    indexer outage (DNS/connection/timeout/non-2xx) is swallowed so the healthy
    swap+fee path still proceeds. Uses a raw urllib call (not _http, which exits on
    error) so every failure mode is caught here."""
    if not re.match(r"^0x[0-9a-fA-F]{40}$", wallet or ""):
        return  # only a validated 0x-address goes into the URL path
    try:
        req = urllib.request.Request(f"{REBATE_INDEXER_URL}/tier/{wallet}", method="GET")
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- fixed https REBATE_INDEXER_URL + a validated 0x-address path segment.
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception:
        # Best-effort + non-blocking by design (see docstring): every failure mode of the
        # rebate-indexer GET is swallowed so a swap never aborts on an enrollment hiccup.
        pass


def to_wei(amount_human: str, decimals: int) -> int:
    from decimal import Decimal
    return int(Decimal(amount_human) * (Decimal(10) ** decimals))


# ── Stable-pair fee tier: DERIVED from a verified stablecoin registry (NOT caller input) ──
# AUTO-DERIVED from the Ophis frontend STABLECOINS (apps/frontend/libs/common-const/src/tokens.ts),
# the same verified source swap.ophis.fi uses for the 1bp stable-pair tier. Lowercased.
# Conservative: a pair not in a chain's set gets the standard rate (never undercharges).
STABLECOINS = {
    1: {"0x056fd409e1d7a124bd7017459dfea2f387b6d5cd", "0x39b8b6385416f4ca36a20319f70d28621895279d", "0x57ab1ec28d129707052df4df418d58a2d46d5f51", "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", "0x6b175474e89094c44da98b954eedeac495271d0f", "0x6c3ea9036406852006290770bedfcaba0e23a0e8", "0x853d955acef822db058eb8505911ed77f175b99e", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"},
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
