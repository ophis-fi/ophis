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
    healthy = 1

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = request["method"]
        if method in ("eth_call", "eth_getTransactionReceipt") and int(self.path[1:]) > self.healthy:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"mock upstream unavailable")
            return
        result = {
            "eth_chainId": "0xa",
            "net_version": "10",
            "eth_blockNumber": "0x100",
            "eth_syncing": False,
            "eth_getBlockByNumber": {"number": "0x100", "hash": BLOCK_HASH, "timestamp": "0x123456"},
            "eth_call": CALL_RESULT,
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
    assert len(project["upstreams"]) == 3
    for rule in project["networks"][0]["failsafe"]:
        if "consensus" in rule:
            policy = rule["consensus"]
            assert policy["agreementThreshold"] == 2
            assert policy["disputeBehavior"] == policy["lowParticipantsBehavior"] == "returnError"
            assert policy["maxWaitOnResult"] == policy["maxWaitOnEmpty"] == "12s"
    server = ThreadingHTTPServer(("0.0.0.0", 0), MockRpc)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for index, upstream in enumerate(project["upstreams"], 1):
        upstream["endpoint"] = f"http://host.docker.internal:{server.server_port}/{index}"
    cache = Path.home() / ".cache"
    cache.mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="ophis-quorum-", dir=cache) as folder:
            config_file = Path(folder) / "erpc.yaml"
            config_file.write_text(yaml.safe_dump(config))
            for healthy in (1, 2):
                MockRpc.healthy = healthy
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
                    for method, params in (
                        ("eth_call", [{"to": "0x" + "33" * 20, "data": "0x"}, "0x80"]),
                        ("eth_getTransactionReceipt", [TX_HASH]),
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
                        if healthy == 1:
                            assert result.get("error") and "result" not in result, result
                        else:
                            expected = CALL_RESULT if method == "eth_call" else TX_HASH
                            actual = result.get("result")
                            if isinstance(actual, dict):
                                actual = actual.get("transactionHash")
                            assert actual == expected and "error" not in result, result
                        print(f"PASS {method}: {healthy} valid voter(s), {3 - healthy} HTTP 500 voter(s)", flush=True)
                finally:
                    subprocess.run(["docker", "rm", "-f", container], check=True, stdout=subprocess.DEVNULL)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
