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
    from credit_gate import cost
    counts = collections.Counter()
    mode = {"disagree": False, "fail": False, "trace_fail": False,
            "latest_skew": False, "header_disagree": False,
            "official_fail": False, "paid_disagree": False, "zero": False,
            "publicnode_fail": False, "publicnode_disagree": False}
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
                    if self.path == "/quicknode":
                        cost(body)  # Real paid method/parameter boundary, no paid endpoint.
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
                        counts[self.path + ":" + method + ":" + block] += 1
                        value = {"number": "0x100" if block in ("latest", "finalized") else block,
                                 "hash": "0x" + "ab" * 32,
                                 "timestamp": hex(int(time.time())), "transactions": []}
                        if self.path == "/blockdaemon" and mode["latest_skew"] and block == "latest":
                            value["number"] = "0x101"
                        if self.path == "/blockdaemon" and mode["header_disagree"] and block == "0x81":
                            value["hash"] = "0x" + "cd" * 32
                    elif method == "debug_traceTransaction":
                        value = {"type": "CALL", "gasUsed": "0x5208", "calls": []}
                    elif method == "eth_call" and self.path == "/blockdaemon" and mode["disagree"]:
                        value = "0x2"
                    elif method == "eth_call" and self.path == "/quicknode" and mode["paid_disagree"]:
                        value = "0x3"
                    elif method == "eth_call" and self.path == "/publicnode" and mode["publicnode_disagree"]:
                        value = "0x4"
                    if mode["zero"] and method in ("eth_getBalance", "eth_call"):
                        value = "0x0"
                    result = {"jsonrpc": "2.0", "id": body["id"], "result": value}
                    if (self.path == "/publicnode" and mode["publicnode_fail"]) or (self.path == "/blockdaemon" and mode["fail"]) or (self.path == "/official" and mode["official_fail"]) or (
                        self.path == "/quicknode" and mode["trace_fail"] and method == "debug_traceTransaction"
                    ):
                        result = {"jsonrpc": "2.0", "id": body["id"],
                                  "error": {"code": -32000, "message": "mock unavailable"}}
            data = json.dumps(result).encode()
            # Real provider HTTP failures must trigger the same bounded fallback.
            self.send_response(503 if self.path in ("/official", "/blockdaemon", "/publicnode") and "error" in result else 200)
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
            # The container may still be starting; retry only until the deadline.
            pass
        assert time.monotonic() < deadline, "mock proxy did not boot"
        time.sleep(0.2)

    call = [{"to": "0x" + "11" * 20, "data": "0x12345678"}, "latest"]
    assert rpc("eth_call", call).get("result") == "0x1"
    assert post(control, {"zero": True})["counts"].get("/quicknode:eth_call", 0) == 0, "paid read despite healthy free quorum"
    assert rpc("eth_getBalance", [call[0]["to"], "0x80"]).get("result") == "0x0"
    assert post(control, {"zero": False})["counts"].get("/quicknode:eth_getBalance", 0) == 0, "zero balance triggered paid fallback"
    # Test-only per-method budget exhausts one free provider locally (no HTTP error).
    for _ in range(2):
        assert rpc("eth_getCode", [call[0]["to"], "0x80"]).get("result") == "0x1"
    assert post(control, {})["counts"].get("/quicknode:eth_getCode", 0) == 1, "local free limit did not fall back"
    post(control, {"disagree": True})
    assert "error" in rpc("eth_call", call), "disagreement accepted or live state cached"
    assert "error" in rpc("eth_call", call, {
        "X-ERPC-Skip-Consensus": "true", "X-ERPC-Use-Upstream": "arc-official"
    }), "client bypassed quorum"
    post(control, {"disagree": False, "fail": True})
    assert rpc("eth_call", call).get("result") == "0x1", "paid fallback did not restore quorum"
    assert post(control, {})["counts"].get("/quicknode:eth_call", 0) == 1
    # Quote simulation overrides must survive fallback unchanged.
    assert rpc("eth_call", [*call, {call[0]["to"]: {"code": "0x00", "balance": "0x100"}}]).get("result") == "0x1"
    for method, params in [("eth_getBalance", [call[0]["to"], "0x80"]),
                           ("eth_getCode", [call[0]["to"], "0x80"]), ("eth_estimateGas", call)]:
        previous = post(control, {})["counts"].get("/quicknode:" + method, 0)
        assert rpc(method, params).get("result") == "0x1", method
        assert post(control, {})["counts"].get("/quicknode:" + method, 0) == previous + 1
    assert rpc("eth_getBlockByNumber", ["0x82", False]).get("result", {}).get("number") == "0x82", "quote block fallback failed"
    post(control, {"paid_disagree": True})
    assert "error" in rpc("eth_call", call), "conflicting paid response accepted"
    before = post(control, {"paid_disagree": False, "official_fail": True})["counts"]
    assert "error" in rpc("eth_call", call), "paid provider counted as two voters"
    after = post(control, {})["counts"]
    assert sum(after.get(source + ":eth_call", 0) - before.get(source + ":eth_call", 0)
               for source in ("/official", "/blockdaemon", "/quicknode")) <= 6, "fallback amplified beyond six attempts"
    assert "error" in rpc("eth_call", call, {
        "X-ERPC-Skip-Consensus": "true", "X-ERPC-Use-Upstream": "arc-quicknode"
    }), "client bypassed fallback quorum"
    # Gas price is an existing single-provider hint, not a simulation quorum.
    before = post(control, {})["counts"]
    assert rpc("eth_gasPrice", []).get("result") == "0x1", "HTTP 503 gas-price fallback failed"
    after = post(control, {})["counts"]
    for source in ("/official", "/blockdaemon", "/quicknode"):
        assert after.get(source + ":eth_gasPrice", 0) == before.get(source + ":eth_gasPrice", 0) + 1, "gas-price sweep skipped or duplicated a provider"
    post(control, {"fail": False, "official_fail": False})

    # Moving latest heads must be pinned before quorum; actual header disputes fail.
    before = post(control, {"latest_skew": True})["counts"]
    assert rpc("eth_getBlockByNumber", ["latest", False]).get("result", {}).get("number") == "0x100"
    after = post(control, {"latest_skew": False, "header_disagree": True})["counts"]
    for source in ["/official", "/blockdaemon"]:
        key = source + ":eth_getBlockByNumber:0x100"
        assert after.get(key, 0) == before.get(key, 0) + 1, "latest was not pinned for both voters"
    assert "error" in rpc("eth_getBlockByNumber", ["0x81", False]), "conflicting header accepted"
    post(control, {"header_disagree": False})

    # A numbered finalized header is cached; dynamic calls above are not.
    assert "result" in rpc("eth_getBlockByNumber", ["0x80", False])
    time.sleep(0.2)  # Cache writes are asynchronous.
    before = post(control, {})["counts"]
    assert "result" in rpc("eth_getBlockByNumber", ["0x80", False])
    after = post(control, {})["counts"]
    assert before == after, "finalized header missed cache"

    # Only a successful two-provider result for immutable state may be reused.
    fixed_call = [call[0], "0x80"]
    post(control, {"disagree": True})
    assert "error" in rpc("eth_call", fixed_call), "unverified call cached"
    post(control, {"disagree": False, "zero": True})
    assert rpc("eth_call", fixed_call).get("result") == "0x0", "failure poisoned cache"
    time.sleep(0.2)
    before = post(control, {"zero": False})["counts"]
    assert rpc("eth_call", fixed_call).get("result") == "0x0", "finalized zero call missed cache"
    assert post(control, {})["counts"] == before, "cache hit made upstream calls"
    for params in [
        [{**call[0], "data": "0x87654321"}, "0x80"],
        [{**call[0], "from": "0x" + "22" * 20}, "0x80"],
        [call[0], "0x79"],
    ]:
        assert rpc("eth_call", params).get("result") == "0x1", "cache key omitted call context"
    # Neither state overrides nor block overrides nor pending state can be cached.
    for params in [
        [*fixed_call, {call[0]["to"]: {"balance": "0x100"}}],
        [*fixed_call, {}, {"time": "0x1"}],
        [call[0], "pending"],
    ]:
        assert rpc("eth_call", params).get("result") == "0x1"
        time.sleep(0.2)
        post(control, {"disagree": True})
        assert "error" in rpc("eth_call", params), "mutable/override call was cached"
        post(control, {"disagree": False})

    # Read fallback and tracing share one weighted budget, including failed calls.
    before = post(control, {})["counts"]
    assert before.get("/quicknode:eth_getBlockByNumber", 0) == 3  # Two bootstrap polls, one fallback.
    assert before.get("/quicknode:eth_syncing", 0) == 0
    post(control, {"trace_fail": True})
    assert "error" in rpc("debug_traceTransaction", ["0x" + "33" * 32, {"tracer": "callTracer"}])
    post(control, {"trace_fail": False})
    spent = sum(count * (40 if key.endswith(":debug_traceTransaction") else 20)
                for key, count in post(control, {})["counts"].items()
                if key.startswith("/quicknode:") and key.count(":") == 1)
    successes = (500 - spent) // 40
    for i in range(successes):
        response = rpc("debug_traceTransaction", ["0x" + f"{i+1:064x}", {"tracer": "callTracer"}])
        assert "result" in response, (response, post(control, {}))
    assert "error" in rpc("debug_traceTransaction", ["0x" + "44" * 32, {"tracer": "callTracer"}]), "credit cap bypassed"
    after = post(control, {})["counts"]
    assert after.get("/quicknode:debug_traceTransaction", 0) == successes + 1, ("retry amplified paid calls", after)
    assert not any(k.endswith(":debug_traceTransaction") and not k.startswith("/quicknode:") for k in after)
    assert "error" in rpc("debug_traceBlockByNumber", ["latest", {}])
    assert rpc("eth_call", call).get("result") == "0x1", "paid exhaustion broke free quorum"
    # Consume any last 20-credit read permit; both free nodes stay unavailable.
    post(control, {"fail": True, "official_fail": True})
    assert "error" in rpc("eth_call", call)
    before = post(control, {})["counts"]
    assert "error" in rpc("eth_call", call)
    after = post(control, {"fail": False, "official_fail": False})["counts"]
    assert after.get("/quicknode:eth_call", 0) == before.get("/quicknode:eth_call", 0), "read credit cap bypassed"
    if release:
        assert 'result' in rpc('eth_sendRawTransaction', ['0xdead'])
        expected = dict(after)
        expected['/official:eth_sendRawTransaction'] = 1
        assert post(control, {})['counts'] == expected, 'Relay retried, duplicated or reached paid upstream'
    else:
        assert "error" in rpc("eth_sendRawTransaction", ["0xdead"])
        assert post(control, {})["counts"] == after, "disallowed method reached upstream"
    print("PASS: quorum, no bypass, finalized-only header/call cache, weighted cap, bounded attempts, denied methods; zero live RPC calls")


def check_free_reads(rpc_url, control):
    def rpc(headers=None):
        return post(rpc_url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                             "params": [{"to": "0x" + "11" * 20, "data": "0x12345678"}, "latest"]}, headers)

    deadline = time.monotonic() + 20
    while True:
        try:
            if rpc().get("result") == "0x1":
                break
        except (URLError, OSError):
            # Container startup is asynchronous; retry only until the deadline.
            pass
        assert time.monotonic() < deadline, "four-provider mock proxy did not boot"
        time.sleep(.2)
    post(control, {"official_fail": True})
    assert rpc().get("result") == "0x1", "two independent free providers did not restore quorum"
    counts = post(control, {})["counts"]
    assert counts.get("/publicnode:eth_call", 0) > 0
    assert counts.get("/quicknode:eth_call", 0) == 0, "healthy free pair consumed paid credits"

    before = post(control, {"fail": True})["counts"]
    response = rpc()
    assert response.get("result") == "0x1", ("PublicNode plus paid fallback failed", response, post(control, {}))
    after = post(control, {})["counts"]
    assert after.get("/quicknode:eth_call", 0) == before.get("/quicknode:eth_call", 0) + 1
    post(control, {"paid_disagree": True})
    assert "error" in rpc(), "disagreement with the new read voter accepted"
    post(control, {"publicnode_fail": True, "paid_disagree": False})
    before = post(control, {})["counts"]
    assert "error" in rpc(), "one surviving provider counted as two voters"
    after = post(control, {})["counts"]
    assert sum(after.get(source + ":eth_call", 0) - before.get(source + ":eth_call", 0)
               for source in ("/official", "/blockdaemon", "/publicnode", "/quicknode")) <= 6
    assert after.get("/quicknode:eth_call", 0) <= before.get("/quicknode:eth_call", 0) + 1
    assert "error" in rpc({"X-ERPC-Skip-Consensus": "true", "X-ERPC-Use-Upstream": "arc-publicnode"})
    post(control, {"publicnode_fail": False, "official_fail": False, "fail": False,
                   "disagree": True, "publicnode_disagree": True, "paid_disagree": True})
    assert "error" in rpc(), "conflicting free providers accepted"
    print("PASS: additional free voter, free-first failover, paid fallback, disagreement and single-voter rejection")


def test_rpc(release=False, expanded=False):
    import yaml  # Existing infra-test dependency; mocks use only Python stdlib.

    root = Path(__file__).resolve().parent
    config = yaml.safe_load((root / ("release/generated/erpc.yaml" if release else "erpc.yaml")).read_text())
    project = config["projects"][0]
    upstreams = project["upstreams"]
    assert [u["id"] for u in upstreams] == ["arc-official", "arc-blockdaemon", "arc-publicnode", "arc-quicknode"]
    assert upstreams[2]["endpoint"] == "https://arc-rpc.publicnode.com"
    assert set(upstreams[2]["allowMethods"]) == {"eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_getBalance", "eth_getCode", "eth_getBlockByNumber", "eth_gasPrice"}
    assert config["rateLimiters"]["budgets"][-1] == {"id": "arc-publicnode", "rules": [{"method": "*", "maxCount": 120, "period": "minute"}]}
    assert all(u["rateLimitCountMode"] == "credit" for u in upstreams)
    assert set(upstreams[-1]["allowMethods"]) == {"eth_call", "eth_estimateGas", "eth_getBalance", "eth_getCode", "eth_getBlockByNumber", "eth_gasPrice", "debug_traceTransaction"}
    assert upstreams[-1]["creditUnits"] == {"*": 20, "debug_traceTransaction": 40}
    assert project["allowClientDirectives"] == ""
    assert project["upstreamDefaults"]["rateLimitAutoTune"]["enabled"] is False
    protected, other = project["networks"][0]["failsafe"]
    assert protected["retry"]["maxAttempts"] == 3 and other["retry"]["maxAttempts"] == 1
    assert protected["consensus"]["maxParticipants"] == protected["consensus"]["agreementThreshold"] == 2
    assert project["upstreamDefaults"]["failsafe"][0]["retry"]["maxAttempts"] == 1
    assert config["rateLimiters"]["budgets"][0]["rules"] == [
        {"method": "*", "maxCount": 1000, "period": "minute"},
        {"method": "*", "maxCount": 40000, "period": "day"},
    ]
    if not expanded:
        # Also retain the existing paid-budget suite with the new free leg absent.
        # Otherwise a healthy extra voter would hide the fallback/cap scenarios.
        upstreams.pop(2)

    name = "arc-rpc-test-" + uuid.uuid4().hex[:10]
    mock, proxy = name + "-mock", name + "-proxy"
    # Hard network isolation and replacement of EVERY endpoint prevent credit use.
    for upstream in upstreams:
        upstream["endpoint"] = "http://" + mock + ":8000/" + upstream["id"].removeprefix("arc-")
    # Cap assertions spend one window; a wall-clock minute reset refills it
    # mid-test. Production periods are asserted above, before this fixture override.
    config["rateLimiters"]["budgets"][0]["rules"][0].update(maxCount=500, period="year")
    config["rateLimiters"]["budgets"][2]["rules"].append(
        {"method": "eth_getCode", "maxCount": 1, "period": "year"})
    image = yaml.safe_load((root / "docker-compose.yml").read_text())["services"]["rpc-proxy"]["image"]
    try:
        docker("network", "create", "--internal", name)
        with tempfile.TemporaryDirectory(prefix="arc-rpc-test-", dir=root) as directory:
            config_path = Path(directory) / "erpc.yaml"
            config_path.write_text(yaml.safe_dump(config))
            docker("run", "-d", "--name", mock, "--network", name,
                   "-v", f"{Path(__file__).resolve()}:/test_rpc.py:ro",
                   "-v", f"{root / 'credit_gate.py'}:/credit_gate.py:ro",
                   "python:3.13-alpine@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f",
                   "python", "/test_rpc.py", "--serve")
            docker("exec", mock, "python", "-c",
                   "import time, urllib.request; time.sleep(0.5); "
                   "urllib.request.urlopen(urllib.request.Request('http://localhost:8000/control', b'{}'))")
            docker("run", "-d", "--name", proxy, "--network", name,
                   "-v", f"{config_path}:/erpc.yaml:ro", image)
            print(docker("exec", mock, "python", "/test_rpc.py", "--check-free" if expanded else "--check",
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
    elif sys.argv[1:2] == ["--check-free"]:
        check_free_reads(*sys.argv[2:4])
    else:
        test_rpc(release='--release' in sys.argv, expanded=True)
        test_rpc(release='--release' in sys.argv)
