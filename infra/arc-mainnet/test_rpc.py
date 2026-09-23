#!/usr/bin/env python3
"""Exercise the real proxy against mocks on a Docker network without internet."""
import collections
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid


def serve_mock():
    counts = collections.Counter()
    mode = {"disagree": False, "fail": False, "trace_fail": False}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with lock:
                if self.path == "/control":
                    mode.update(body)
                    result = {"counts": dict(counts)}
                else:
                    method = body["method"]
                    counts[self.path + ":" + method] += 1
                    value = "0x1"
                    if method == "eth_chainId":
                        value = "0x13b2"
                    elif method == "eth_syncing":
                        value = False
                    elif method == "eth_blockNumber":
                        value = "0x100"
                    elif method == "eth_getBlockByNumber":
                        block = body["params"][0]
                        value = {"number": "0x100" if block in ("latest", "finalized") else block,
                                 "hash": "0x" + "ab" * 32,
                                 "timestamp": hex(int(time.time())), "transactions": []}
                    elif method == "debug_traceTransaction":
                        value = {"type": "CALL", "gasUsed": "0x5208", "calls": []}
                    elif method == "eth_call" and self.path == "/blockdaemon" and mode["disagree"]:
                        value = "0x2"
                    result = {"jsonrpc": "2.0", "id": body["id"], "result": value}
                    if (self.path == "/blockdaemon" and mode["fail"]) or (
                        self.path == "/quicknode" and mode["trace_fail"] and method == "debug_traceTransaction"
                    ):
                        result = {"jsonrpc": "2.0", "id": body["id"],
                                  "error": {"code": -32000, "message": "mock unavailable"}}
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()


def post(url, data, headers=None):
    request = Request(url, json.dumps(data).encode(),
                      {"Content-Type": "application/json", **(headers or {})})
    try:
        response = urlopen(request, timeout=20)
    except HTTPError as error:
        response = error
    with response:
        return json.load(response)


def docker(*args):
    result = subprocess.run(["docker", *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(result.stdout)
    return result.stdout.strip()


def check_proxy(rpc_url, control, release=False):
    def rpc(method, params, headers=None):
        return post(rpc_url, {"jsonrpc": "2.0", "id": 1,
                              "method": method, "params": params}, headers)

    deadline = time.monotonic() + 20
    while True:
        try:
            if rpc("eth_chainId", []).get("result") == "0x13b2":
                break
        except (URLError, OSError):
            pass
        assert time.monotonic() < deadline, "mock proxy did not boot"
        time.sleep(0.2)

    call = [{"to": "0x" + "11" * 20, "data": "0x12345678"}, "0x80"]
    assert rpc("eth_call", call).get("result") == "0x1"
    post(control, {"disagree": True})
    assert "error" in rpc("eth_call", call), "disagreement accepted or live state cached"
    assert "error" in rpc("eth_call", call, {
        "X-ERPC-Skip-Consensus": "true", "X-ERPC-Use-Upstream": "arc-official"
    }), "client bypassed quorum"
    post(control, {"disagree": False, "fail": True})
    assert "error" in rpc("eth_call", call), "missing voter accepted"
    post(control, {"fail": False})

    # A numbered finalized header is cached; dynamic calls above are not.
    assert "result" in rpc("eth_getBlockByNumber", ["0x80", False])
    time.sleep(0.2)  # Cache writes are asynchronous.
    before = post(control, {})["counts"]
    assert "result" in rpc("eth_getBlockByNumber", ["0x80", False])
    after = post(control, {})["counts"]
    assert before == after, "finalized header missed cache"

    # Bootstrap consumed 60 credits (chain ID + two headers), leaving three traces.
    before = post(control, {})["counts"]
    assert before.get("/quicknode:eth_getBlockByNumber", 0) == 2
    assert before.get("/quicknode:eth_syncing", 0) == 0
    for i in range(2):
        response = rpc("debug_traceTransaction", ["0x" + f"{i+1:064x}", {"tracer": "callTracer"}])
        assert "result" in response, (response, post(control, {}))
    post(control, {"trace_fail": True})
    assert "error" in rpc("debug_traceTransaction", ["0x" + "33" * 32, {"tracer": "callTracer"}])
    post(control, {"trace_fail": False})
    assert "error" in rpc("debug_traceTransaction", ["0x" + "44" * 32, {"tracer": "callTracer"}]), "credit cap bypassed"
    after = post(control, {})["counts"]
    assert after.get("/quicknode:debug_traceTransaction", 0) == 3, ("retry amplified paid calls", after)
    assert not any(k.endswith(":debug_traceTransaction") and not k.startswith("/quicknode:") for k in after)
    assert "error" in rpc("debug_traceBlockByNumber", ["latest", {}])
    if release:
        assert 'result' in rpc('eth_sendRawTransaction', ['0xdead'])
        expected = dict(after)
        expected['/official:eth_sendRawTransaction'] = 1
        assert post(control, {})['counts'] == expected, 'Relay retried, duplicated or reached paid upstream'
    else:
        assert "error" in rpc("eth_sendRawTransaction", ["0xdead"])
        assert post(control, {})["counts"] == after, "disallowed method reached upstream"
    print("PASS: quorum, no bypass, header cache, weighted cap, bounded attempts, denied methods; zero live RPC calls")


def test_rpc(release=False):
    import yaml  # Existing infra-test dependency; mocks use only Python stdlib.

    root = Path(__file__).resolve().parent
    config = yaml.safe_load((root / ("release/generated/erpc.yaml" if release else "erpc.yaml")).read_text())
    project = config["projects"][0]
    upstreams = project["upstreams"]
    assert [u["id"] for u in upstreams] == ["arc-official", "arc-blockdaemon", "arc-quicknode"]
    assert all(u["rateLimitCountMode"] == "credit" for u in upstreams)
    assert upstreams[-1]["allowMethods"] == ["debug_traceTransaction"]
    assert upstreams[-1]["creditUnits"] == {"*": 20, "debug_traceTransaction": 40}
    assert project["allowClientDirectives"] == ""
    assert project["upstreamDefaults"]["rateLimitAutoTune"]["enabled"] is False
    assert all(f["retry"]["maxAttempts"] == 1 for f in project["networks"][0]["failsafe"])
    assert project["upstreamDefaults"]["failsafe"][0]["retry"]["maxAttempts"] == 1
    assert config["rateLimiters"]["budgets"][0]["rules"] == [
        {"method": "*", "maxCount": 1000, "period": "minute"},
        {"method": "*", "maxCount": 40000, "period": "day"},
    ]

    name = "arc-rpc-test-" + uuid.uuid4().hex[:10]
    mock, proxy = name + "-mock", name + "-proxy"
    # Hard network isolation and replacement of EVERY endpoint prevent credit use.
    for upstream in upstreams:
        upstream["endpoint"] = "http://" + mock + ":8000/" + upstream["id"].removeprefix("arc-")
    config["rateLimiters"]["budgets"][0]["rules"][0]["maxCount"] = 180
    image = yaml.safe_load((root / "docker-compose.yml").read_text())["services"]["rpc-proxy"]["image"]
    try:
        docker("network", "create", "--internal", name)
        with tempfile.TemporaryDirectory(prefix="arc-rpc-test-", dir=root) as directory:
            config_path = Path(directory) / "erpc.yaml"
            config_path.write_text(yaml.safe_dump(config))
            docker("run", "-d", "--name", mock, "--network", name,
                   "-v", f"{Path(__file__).resolve()}:/test_rpc.py:ro",
                   "python:3.13-alpine@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f",
                   "python", "/test_rpc.py", "--serve")
            docker("exec", mock, "python", "-c",
                   "import time, urllib.request; time.sleep(0.5); "
                   "urllib.request.urlopen(urllib.request.Request('http://localhost:8000/control', b'{}'))")
            docker("run", "-d", "--name", proxy, "--network", name,
                   "-v", f"{config_path}:/erpc.yaml:ro", image)
            print(docker("exec", mock, "python", "/test_rpc.py", "--check",
                         f"http://{proxy}:4000/main/evm/5042", "http://localhost:8000/control", *(['--release'] if release else [])))

    except Exception:
        for container in (mock, proxy):
            print(docker("logs", container)[-8000:])
            print(docker("inspect", container, "--format", "{{json .NetworkSettings.Ports}}"))
        raise
    finally:
        for container in (proxy, mock):
            subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        serve_mock()
    elif sys.argv[1:2] == ["--check"]:
        check_proxy(*sys.argv[2:4], release='--release' in sys.argv)
    else:
        test_rpc(release='--release' in sys.argv)
