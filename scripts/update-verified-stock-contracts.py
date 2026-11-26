#!/usr/bin/env python3
"""Refresh swap issuer badges from public issuer records. Inspect the generated diff before shipping."""
import csv
import io
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "apps/frontend/apps/cowswap-frontend"
OUTPUT = APP / "src/entities/verifiedAsset/stockContracts.json"
SOLANA, TRON = 1_000_000_001, 1_000_000_102
EVM = re.compile(r"0x[\da-fA-F]{40}", re.ASCII)
ONDO = ("https://www.dropbox.com/scl/fi/qjfxyg748mx0dwi6up86d/"
        "EXTERNAL-Ondo-GM-Tokens-Ondo-GM-Tokens.csv?rlkey=n3no1w78wrah3umsl0nr9s77i&dl=1")


def fetch(url):
    return subprocess.check_output(["curl", "--fail", "--location", "--silent", "--show-error",
                                    "--max-time", "60", "--retry", "2", url]).decode("utf-8-sig")


def load(url):
    return json.loads(fetch(url))


def bstocks_contracts():
    """Match Binance's bStocks classification to its explicit BSC contracts in listing notices."""
    base = "https://www.binance.com/bapi/"
    assets = load(base + "asset/v2/public/asset/asset/get-all-asset")["data"]
    symbols = {a["assetCode"] for a in assets if "bStocks" in (a.get("tags") or [])}
    cms = base + "composite/v1/public/cms/article/"
    contracts = {}
    page = 1
    while True:
        catalog = load(cms + f"list/query?type=1&pageNo={page}&pageSize=50&catalogId=48")["data"]["catalogs"][0]
        for notice in catalog["articles"]:
            if "bstock" not in notice["title"].lower() or "trading pair" not in notice["title"].lower():
                continue
            article = load(cms + "detail/query?articleCode=" + notice["code"])["data"]
            body = json.loads(article["body"])
            text = " ".join(article_text(body))
            for symbol, address in re.findall(r"\b([A-Z0-9]+)\s*:\s*(0x[0-9a-fA-F]{40})\b", text):
                if symbol in symbols:
                    address = address.lower()
                    if symbol in contracts and contracts[symbol] != address:
                        raise ValueError(f"Conflicting Binance contracts for {symbol}: {contracts[symbol]} and {address}")
                    contracts[symbol] = address
        # First BSC listings went live on 11 June 2026.
        if not catalog["articles"] or min(n["releaseDate"] for n in catalog["articles"]) < 1781136000000:
            break
        page += 1
    if contracts.get("NVDAB") != "0x02fca66c1d1afb4e2a7884261eb00f63598a7436":
        raise ValueError("Missing expected Binance NVDAB deployment")
    return contracts.items()


def article_text(node):
    if node.get("node") == "text":
        yield node["text"]
    for child in node.get("child", []):
        yield from article_text(child)


def stock_contracts():
    swap_chains = set(map(int, json.loads((ROOT / "apps/frontend/libs/tokens/src/const/tokensList.json").read_text())))
    # Ophis also supports these bridge destinations, including Solana mainnet.
    supported_chains = swap_chains | {143, 196, 999, SOLANA, TRON}
    rows = defaultdict(dict)

    def add(issuer, chain, address, symbol):
        if not address or chain not in supported_chains:
            return
        if chain == SOLANA:
            if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", address):
                raise ValueError(f"Invalid Solana mint for {symbol}: {address}")
        elif chain == TRON:
            if not re.fullmatch(r"T[1-9A-HJ-NP-Za-km-z]{33}", address):
                raise ValueError(f"Invalid Tron address for {symbol}: {address}")
        else:
            if not EVM.fullmatch(address) or int(address, 16) == 0:
                raise ValueError(f"Invalid EVM address for {symbol} on {chain}: {address}")
            address = address.lower()
        identity = (issuer, symbol.upper())
        previous = rows[address].get(chain)
        if previous is not None and previous != identity:
            raise ValueError(f"Conflicting identities for {chain}/{address}: {previous} and {identity}")
        rows[address][chain] = identity

    # https://docs.xstocks.fi/apis/openapi/assets/list_public_assets
    for page in range(1000):
        result = load(f"https://api.xstocks.fi/api/v2/public/assets?page={page}")
        if result["page"]["currentPage"] != page or not result["nodes"]:
            raise ValueError(f"Missing or unexpected xStocks page {page}")
        for asset in result["nodes"]:
            if not asset["underlying"]:
                continue
            for deployment in asset["deployments"]:
                chain = {"Solana": SOLANA, "Tron": TRON}.get(deployment["network"], deployment["chainId"])
                if chain is None:
                    continue
                add("xStocks", chain, deployment["address"], asset["symbol"])
                for version in ("wrapperAddress", "wrapperAddressV2"):
                    add("wrappedXStocks", chain, deployment.get(version), "w" + asset["symbol"])
        if not result["page"]["hasNextPage"]:
            break
    else:
        raise ValueError("Incomplete xStocks pagination")

    # Official CSV linked from https://docs.ondo.finance/addresses
    for row in csv.DictReader(io.StringIO(fetch(ONDO))):
        if row["Type"] in ("Stock", "ETF"):
            for network, chain in [("Ethereum", 1), ("BSC", 56), ("Solana", SOLANA),
                                   ("HyperEVM", 999), ("Robinhood Chain", 4663)]:
                add("ondo", chain, row[f"{network} Deployed Address"].strip(), row["Symbol"])

    # Bitget identifies Reality instruments explicitly and lists chain-specific contracts.
    bitget = "https://api.bitget.com"
    instruments = load(bitget + "/api/v3/market/instruments?category=SPOT")["data"]
    reality = {item["baseCoin"] for item in instruments if item.get("isReality") == "yes" and item.get("status") == "online"}
    if not reality:
        raise ValueError("Missing active Reality instruments from Bitget")
    for coin in load(bitget + "/api/v2/spot/public/coins")["data"]:
        if coin["coin"] in reality:
            for deployment in coin["chains"]:
                if deployment["chain"] == "ArbitrumOne":
                    add("reality", 42161, deployment["contractAddress"], coin["coin"])

    for asset in load("https://api.robinhood.com/rhj/assets")["assets"]:
        if asset["status"] != "ASSET_STATUS_ACTIVE":
            continue
        for deployment in asset["deployments"]:
            add("robinhood", deployment["chainId"], deployment["contractAddress"], asset["tokenSymbol"])

    lists = APP / "public/token-lists"
    for token in json.loads((lists / "coinbase-tokenized-stocks.json").read_text())["tokens"]:
        add("coinbase", token["chainId"], token["address"], token["symbol"])
    # Recorded Circle CCTPx pairs (https://iris-api.circle.com/v2/cctpx/tokens).
    # Require an exact issuer-listed origin for the mapped symbol and destination.
    mappings = json.loads((APP / "src/entities/cctp/cctpxAssets.json").read_text())
    for symbol, mapping in mappings.items():
        chain = mapping.get("homeChainId")
        addresses = mapping["addresses"]
        origin = addresses.get(str(chain))
        if origin and rows.get(origin.lower(), {}).get(chain) == ("ondo", symbol.upper()):
            add("bridgedOndo", 5042, addresses.get("5042"), symbol)

    for symbol, address in bstocks_contracts():
        add("bStocks", 56, address, symbol)

    # An address can have different deployments on different networks. Group only identical chain sets.
    groups = defaultdict(list)
    for address, deployments in rows.items():
        for issuer, symbol in set(deployments.values()):
            chains = tuple(sorted(chain for chain, identity in deployments.items() if identity == (issuer, symbol)))
            groups[issuer, chains].append((address, symbol))
    return [{"issuer": issuer, "chains": chains, "tokens": dict(sorted(addresses))}
            for (issuer, chains), addresses in sorted(groups.items())]


if __name__ == "__main__":
    groups = stock_contracts()
    expected = {"xStocks", "wrappedXStocks", "ondo", "bridgedOndo", "reality", "robinhood", "coinbase", "bStocks"}
    issuers = {g["issuer"] for g in groups}
    if issuers != expected:
        raise ValueError(f"Unexpected snapshot issuers: missing {expected - issuers}, unexpected {issuers - expected}")
    with TemporaryDirectory(dir=OUTPUT.parent) as work:
        snapshot = Path(work) / OUTPUT.name
        snapshot.write_text(json.dumps(groups, indent=2) + "\n")
        snapshot.replace(OUTPUT)
