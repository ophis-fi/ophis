"""Local-only eRPC quorum regression: python3 scripts/test-op-erpc-quorum.py.

Requires Docker, the already-installed pinned eRPC image, and PyYAML.
No real RPC endpoints or credentials are used.
"""
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import yaml

ROOT = Path(__file__).resolve().parents[1]
STACK = ROOT / "infra/optimism-mainnet"
TX_HASH = "0x" + "11" * 32
BLOCK_HASH = "0x" + "22" * 32
CALL_RESULT = "0x" + "00" * 31 + "01"
PORT = 14011


class MockRpc(BaseHTTPRequestHandler):
    healthy = {1}
    log_ranges = []
    drpc_log_ranges = []
    alchemy_log_ranges = []
    alchemy_origins = []
    balance_reads = []
    header_reads = []
    failed_headers = set()
    forged_headers = set()
    hash_reads = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = request["method"]
        if self.path == "/2":
            self.alchemy_origins.append(self.headers.get("Origin"))
            if self.headers.get("Origin") != "https://swap.ophis.fi":
                self.send_response(403)
                self.end_headers()
                return
        if method in ("eth_getBlockByHash", "eth_getBlockByNumber"):
            self.header_reads.append(int(self.path[1:]))
            if method == "eth_getBlockByHash":
                self.hash_reads.append(int(self.path[1:]))
            if int(self.path[1:]) in self.failed_headers:
                self.send_response(500)
                self.end_headers()
                return
        if method in ("eth_getBalance", "eth_getCode"):
            self.balance_reads.append(method)
        if method in ("eth_call", "eth_getTransactionReceipt", "eth_getLogs", "eth_getBlockByHash") and int(self.path[1:]) not in self.healthy:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"mock upstream unavailable")
            return
        if method == "eth_getLogs":
            f = request["params"][0]
            size = int(f["toBlock"], 16) - int(f["fromBlock"], 16) + 1
            self.log_ranges.append(size)
            if self.path == "/3":
                self.drpc_log_ranges.append(size)
            if self.path == "/2":
                self.alchemy_log_ranges.append(size)
            if size > (10 if self.path == "/2" else 500):
                self.send_response(413)
                self.end_headers()
                return
        result = {
            "eth_chainId": "0xa",
            "net_version": "10",
            "eth_blockNumber": "0x1000",
            "eth_syncing": False,
            "eth_getBlockByNumber": {"number": "0x1000", "hash": BLOCK_HASH, "timestamp": "0x123456"},
            "eth_getBlockByHash": {"number": "0x1000", "hash": BLOCK_HASH, "timestamp": "0x123456", "logsBloom": "0x" + ("ff" if int(self.path[1:]) in self.forged_headers else "00") * 256},
            "eth_call": CALL_RESULT,
            "eth_getBalance": "0x0",
            "eth_getCode": "0x",
            "eth_getLogs": [],
            "eth_getTransactionReceipt": {
                "transactionHash": TX_HASH, "blockHash": BLOCK_HASH,
                "blockNumber": "0x80", "status": "0x1", "logs": [],
            },
        }.get(method)
        body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    image = next(line.split("=", 1)[1] for line in (STACK / ".env.example").read_text().splitlines()
                 if line.startswith("ERPC_IMAGE="))
    config = yaml.safe_load((STACK / "configs/erpc.yaml.tmpl").read_text())
    project = config["projects"][0]
    project["networks"][0]["selectionPolicy"]["evalInterval"] = "250ms"
    assert len(project["upstreams"]) == 3
    for rule in project["networks"][0]["failsafe"]:
        if "consensus" in rule:
            policy = rule["consensus"]
            assert policy["agreementThreshold"] == 2
            assert policy["disputeBehavior"] == policy["lowParticipantsBehavior"] == "returnError"
            assert policy["maxWaitOnResult"] == policy["maxWaitOnEmpty"] == "12s"
    # Historical log splitting can open more than five local connections at once.
    ThreadingHTTPServer.request_queue_size = 128
    server = ThreadingHTTPServer(("0.0.0.0", 0), MockRpc)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for index, upstream in enumerate(project["upstreams"], 1):
        upstream["endpoint"] = f"http://host.docker.internal:{server.server_port}/{index}"
    # Endpoint replacement must not hide the real vendor's method-price defaults.
    project["upstreams"][1]["vendorName"] = "alchemy"
    upstreams = list(project["upstreams"])
    cache = Path.home() / ".cache"
    cache.mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="ophis-quorum-", dir=cache) as folder:
            config_file = Path(folder) / "erpc.yaml"
            for healthy in ({1}, {1, 2}, {1, 3}, {2, 3}, {1, 2, 3}, 3, 2):
                isolated = isinstance(healthy, int)
                MockRpc.healthy = {healthy} if isolated else healthy
                MockRpc.log_ranges.clear()
                MockRpc.drpc_log_ranges.clear()
                MockRpc.alchemy_log_ranges.clear()
                MockRpc.alchemy_origins.clear()
                MockRpc.hash_reads.clear()
                MockRpc.forged_headers = {1} if healthy == {1, 2, 3} else set()
                if isolated:
                    # Isolate each metered provider's shared limiter locally.
                    # One hour avoids a minute rollover during this short test.
                    project["upstreams"] = [upstreams[healthy - 1]]
                    project["networks"][0]["failsafe"] = [{"matchMethod": "*",
                        "timeout": {"duration": "2s"}, "retry": {"maxAttempts": 1}}]
                    budget = next(b for b in config["rateLimiters"]["budgets"] if b["id"] == project["upstreams"][0]["rateLimitBudget"])
                    budget["rules"][0].update(maxCount=20, period="hour")
                    MockRpc.balance_reads.clear()
                config_file.write_text(yaml.safe_dump(config))
                container = subprocess.check_output([
                    "docker", "run", "--pull=never", "--rm", "-d",
                    "-p", f"127.0.0.1:{PORT}:4000",
                    "-v", f"{config_file}:/erpc.yaml:ro", image,
                ], text=True).strip()
                try:
                    for _ in range(100):
                        try:
                            with urlopen(f"http://127.0.0.1:{PORT}/healthcheck", timeout=1) as response:
                                if response.status == 200:
                                    break
                        except (URLError, OSError):
                            time.sleep(0.1)
                    else:
                        raise AssertionError("Local eRPC failed to become healthy")
                    if isolated:
                        for index in range(40):
                            method = ("eth_getBalance", "eth_getCode")[index % 2]
                            body = json.dumps({"jsonrpc": "2.0", "id": index, "method": method,
                                "params": ["0x" + "33" * 20, "0x80"]}).encode()
                            try:
                                response = urlopen(Request(f"http://127.0.0.1:{PORT}/main/evm/10",
                                    data=body, headers={"Content-Type": "application/json"}), timeout=5)
                            except HTTPError as error:
                                response = error
                            with response:
                                result = json.load(response)
                            assert "result" in result or "error" in result, result
                        assert set(MockRpc.balance_reads) == {"eth_getBalance", "eth_getCode"}
                        assert len(MockRpc.balance_reads) <= 20, MockRpc.balance_reads
                        assert "error" in result, "Exhausted budget must stop forwarding"
                        assert "ErrUpstreamRateLimitRuleExceeded" in json.dumps(result), result
                        print(f"PASS shared {project['upstreams'][0]['id']} budget limits combined traffic across methods", flush=True)
                        continue
                    for method, params in (
                        ("eth_call", [{"to": "0x" + "33" * 20, "data": "0x"}, "0x80"]),
                        ("eth_getTransactionReceipt", [TX_HASH]),
                        ("eth_getLogs", [{"fromBlock": "0x80", "toBlock": "0xe4"}]),
                        ("eth_getBlockByHash", [BLOCK_HASH, False]),
                    ):
                        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
                        req = Request(f"http://127.0.0.1:{PORT}/main/evm/10", data=body,
                                      headers={"Content-Type": "application/json"})
                        try:
                            response = urlopen(req, timeout=15)
                        except HTTPError as error:
                            response = error
                        with response:
                            result = json.load(response)
                        if len(healthy) == 1:
                            assert result.get("error") and "result" not in result, result
                        else:
                            expected = {"eth_call": CALL_RESULT, "eth_getTransactionReceipt": TX_HASH, "eth_getLogs": [], "eth_getBlockByHash": BLOCK_HASH}[method]
                            actual = result.get("result")
                            if isinstance(actual, dict):
                                actual = actual.get("hash" if method == "eth_getBlockByHash" else "transactionHash")
                            assert actual == expected and "error" not in result, result
                            if method == "eth_getBlockByHash":
                                assert result["result"]["logsBloom"] == "0x" + "00" * 256
                                time.sleep(0.25)
                                reads = list(MockRpc.hash_reads)
                                with urlopen(req, timeout=15) as response:
                                    assert json.load(response)["result"]["hash"] == BLOCK_HASH
                                assert MockRpc.hash_reads == reads, "Only consensus-verified immutable headers may be reused"
                        if method == "eth_getLogs":
                            assert MockRpc.log_ranges and max(MockRpc.log_ranges) <= 500, MockRpc.log_ranges
                            if 2 in healthy:
                                assert MockRpc.alchemy_log_ranges and max(MockRpc.alchemy_log_ranges) <= 10, MockRpc.alchemy_log_ranges
                            if 3 in healthy:
                                assert MockRpc.drpc_log_ranges and max(MockRpc.drpc_log_ranges) <= 100, MockRpc.drpc_log_ranges
                        assert MockRpc.alchemy_origins and set(MockRpc.alchemy_origins) == {"https://swap.ophis.fi"}
                        print(f"PASS {method}: healthy voters {sorted(healthy)}", flush=True)
                    if healthy == {1, 3}:
                        body = json.dumps({"jsonrpc": "2.0", "id": 2,
                            "method": "eth_getBlockByNumber", "params": ["latest", False]}).encode()
                        req = Request(f"http://127.0.0.1:{PORT}/main/evm/10", data=body,
                                      headers={"Content-Type": "application/json"})
                        with urlopen(req, timeout=15) as response:
                            assert json.load(response)["result"]["hash"] == BLOCK_HASH
                        time.sleep(0.5)
                        MockRpc.header_reads.clear()
                        with urlopen(req, timeout=15) as response:
                            assert json.load(response)["result"]["hash"] == BLOCK_HASH
                        assert MockRpc.header_reads == [1], MockRpc.header_reads
                        MockRpc.failed_headers = {1, 2}
                        MockRpc.header_reads.clear()
                        try:
                            with urlopen(req, timeout=15) as response:
                                assert json.load(response)["result"]["hash"] == BLOCK_HASH
                            assert 3 in MockRpc.header_reads, MockRpc.header_reads
                        finally:
                            MockRpc.failed_headers.clear()
                        print("PASS headers prefer official OP and retain dRPC failover", flush=True)
                finally:
                    subprocess.run(["docker", "rm", "-f", container], check=True, stdout=subprocess.DEVNULL)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
