"""Read-only ERC-20 metadata audit. Does not establish issuer authenticity.

python3 scripts/verify-ophis-token-list.py --output /tmp/token-audit.json
python3 scripts/verify-ophis-token-list.py --self-test
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LIST = ROOT / "apps/frontend/apps/cowswap-frontend/public/token-lists/ophis.json"
RPCS = {
    5042: ["https://rpc.mainnet.arc.io"],
    1: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    10: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
    56: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"],
    100: ["https://gnosis-rpc.publicnode.com", "https://rpc.gnosischain.com"],
    130: ["https://unichain-rpc.publicnode.com", "https://mainnet.unichain.org"],
    137: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    4663: ["https://robinhood-rpc.publicnode.com", "https://hood-rpc.pastrylabs.cloud"],
    8453: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    9745: ["https://rpc.plasma.to", "https://plasma.drpc.org"],
    42161: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    43114: ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"],
    57073: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com"],
    59144: ["https://linea-rpc.publicnode.com", "https://rpc.linea.build"],
    11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
}


def rpc(url, methods):
    payload = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(methods)]
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={
        "Content-Type": "application/json", "User-Agent": "Ophis token-list verification",
    })
    with urllib.request.urlopen(request, timeout=35) as response:
        raw = json.load(response)
    if not isinstance(raw, list) or len(raw) != len(payload):
        raise ValueError("Incomplete RPC batch")
    by_id = {item["id"]: item for item in raw}
    if set(by_id) != set(range(len(payload))):
        raise ValueError("Invalid RPC response IDs")
    return [by_id[i] for i in range(len(payload))]


def decode_text(result):
    """Accept standard ABI strings and legacy bytes32 metadata (e.g. MKR)."""
    raw = bytes.fromhex(result.removeprefix("0x"))
    if len(raw) == 32:
        return raw.rstrip(b"\0").decode("utf-8")
    if len(raw) < 64 or int.from_bytes(raw[:32], "big") != 32:
        raise ValueError("Invalid ABI string offset")
    size = int.from_bytes(raw[32:64], "big")
    if size > 1024 or 64 + size > len(raw):
        raise ValueError("Invalid ABI string length")
    return raw[64:64 + size].decode("utf-8")


def rpc_with_fallback(chain, urls, methods):
    errors = []
    for url in urls:
        try:
            replies = rpc(url, [("eth_chainId", [])] + methods)
            if int(replies[0]["result"], 16) != chain:
                raise ValueError("Wrong RPC chain ID")
            if any("error" in reply for reply in replies[1:]):
                raise ValueError("RPC batch contains errors")
            return url, replies[1:]
        except Exception as error:
            errors.append(f"{url}: {error}")
    raise ValueError("; ".join(errors))


def audit_chain(chain, tokens):
    errors = []
    for url in RPCS[chain]:
        try:
            header = rpc(url, [("eth_chainId", []), ("eth_blockNumber", [])])
            if int(header[0]["result"], 16) != chain:
                raise ValueError("Wrong RPC chain ID")
            block = header[1]["result"]
            break
        except Exception as error:
            errors.append(f"{url}: {error}")
    else:
        return {"chainId": chain, "errors": errors, "tokens": []}

    results = []
    for start in range(0, len(tokens), 8):
        chunk = tokens[start:start + 8]
        methods = []
        for token in chunk:
            address = token["address"]
            methods.append(("eth_getCode", [address, block]))
            methods.extend(("eth_call", [{"to": address, "data": selector}, block])
                           for selector in ["0x313ce567", "0x95d89b41", "0x06fdde03"])
        responses = None
        for attempt in range(3):
            try:
                batch_url, responses = rpc_with_fallback(chain, RPCS[chain], methods)
                break
            except Exception as error:
                failure = str(error)
                time.sleep(attempt + 1)
        for index, token in enumerate(chunk):
            record = {"address": token["address"], "expectedSymbol": token["symbol"],
                      "expectedDecimals": token["decimals"]}
            try:
                if responses is None:
                    raise ValueError(failure)
                record["rpc"] = batch_url
                code, decimals, symbol, name = responses[index * 4:index * 4 + 4]
                if "result" not in code or code["result"] in ["0x", "0x0"]:
                    raise ValueError("No contract bytecode or failed code lookup")
                record["codeSha256"] = hashlib.sha256(bytes.fromhex(code["result"][2:])).hexdigest()
                record["decimals"] = int(decimals["result"], 16)
                record["symbol"] = decode_text(symbol["result"])
                record["name"] = decode_text(name["result"])
                record["status"] = "pass" if record["decimals"] == token["decimals"] else "decimals_mismatch"
                if record["symbol"] != token["symbol"]:
                    record["symbolDifference"] = True
                if record["name"] != token["name"]:
                    record["nameDifference"] = True
            except Exception as error:
                record.update(status="unverified", error=str(error))
            results.append(record)
        time.sleep(0.15)
    counts = {status: sum(t["status"] == status for t in results) for status in {t["status"] for t in results}}
    print(json.dumps({"chainId": chain, "count": len(results), "statuses": counts}), flush=True)
    return {"chainId": chain, "rpc": url, "block": block, "tokens": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--chain", type=int)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        global rpc
        original_rpc = rpc
        def fake_rpc(url, methods):
            if url == "primary":
                raise ValueError("Rate limited after header probe")
            return [{"result": "0x1" if url == "backup" else "0xa"}, {"result": "0x06"}]
        rpc = fake_rpc
        try:
            url, replies = rpc_with_fallback(1, ["primary", "wrong-chain", "backup"], [("eth_call", [])])
            assert url == "backup" and replies == [{"result": "0x06"}]
        finally:
            rpc = original_rpc
        assert decode_text("0x" + b"MKR".ljust(32, b"\0").hex()) == "MKR"
        assert decode_text("0x" + ((32).to_bytes(32, "big") + (4).to_bytes(32, "big") + b"USDC".ljust(32, b"\0")).hex()) == "USDC"
        try:
            decode_text("0x" + ((32).to_bytes(32, "big") + (999).to_bytes(32, "big")).hex())
        except ValueError:
            pass
        else:
            raise AssertionError("Truncated metadata accepted")
        print("Metadata decoder checks passed")
        return
    if not args.output:
        parser.error("--output is required")
    raw = LIST.read_bytes()
    tokens = json.loads(raw)["tokens"]
    chains = sorted({t["chainId"] for t in tokens if args.chain is None or t["chainId"] == args.chain})
    assert chains and all(chain in RPCS for chain in chains), "Missing chain RPC configuration"
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "listSha256": hashlib.sha256(raw).hexdigest(),
              "scope": "RPC metadata consistency; issuer authenticity requires separate provenance", "chains": []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(audit_chain, chain, [t for t in tokens if t["chainId"] == chain]) for chain in chains]
        for future in as_completed(futures):
            report["chains"].append(future.result())
            args.output.write_text(json.dumps(report, separators=(",", ":")) + "\n")
    assert all(not c.get("errors") and all(t["status"] == "pass" for t in c["tokens"]) for c in report["chains"]), "Some contracts remain unverified"


if __name__ == "__main__":
    main()
