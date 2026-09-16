"""Run with python3 scripts/test-boost-rpc.py (uses CI's existing PyYAML)."""
import copy
import os
from pathlib import Path
import runpy
import subprocess
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[1]
OP = ROOT / "infra/optimism-mainnet"
RBH = ROOT / "infra/robinhood-mainnet"
guard = runpy.run_path(str(OP / "assert-erpc-failclosed.py"))
validate = guard["validate"]
config = yaml.safe_load((OP / "configs/erpc.yaml.tmpl").read_text())
assert not validate(config)
for method in guard["PROTECTED_METHODS"]:
    voters = [u for u in config["projects"][0]["upstreams"]
              if method not in u.get("ignoreMethods", [])
              and method in u.get("allowMethods", [method])]
    assert len(voters) == 3, (method, voters)
bad = copy.deepcopy(config)
next(u for u in bad["projects"][0]["upstreams"] if u["id"] == "goldsky-op").pop("ignoreMethods")
assert validate(bad), "Goldsky must not join the original transaction/receipt/log quorum"
for path in ("/standard/evm/10", "/boost/4663"):
    bad = copy.deepcopy(config)
    upstream = next(u for u in bad["projects"][0]["upstreams"] if u["id"] == "goldsky-op")
    upstream["endpoint"] = f"https://edge.goldsky.com{path}?key=test"
    assert validate(bad), path

for method in ("eth_blockNumber", "eth_getBlockByNumber"):
    bad = copy.deepcopy(config)
    next(u for u in bad["projects"][0]["upstreams"] if u["id"] == "drpc-op")["allowMethods"].remove(method)
    assert validate(bad), "Retained providers need head methods for their state pollers"

bad = copy.deepcopy(config)
bad["projects"][0]["networks"][0].pop("selectionPolicy")
assert validate(bad), "Application head reads must exclude dRPC"
policy = config["projects"][0]["networks"][0]["selectionPolicy"]["evalFunc"]
subprocess.run(["node", "-e", """
const assert = require('node:assert/strict');
const PREFER_FASTEST = 0;
Array.prototype.removeCordoned = function() { return this; };
Array.prototype.whenEmpty = function(f) { return this.length ? this : f(); };
Array.prototype.sortByScore = function() { return this; };
const select = """ + policy + """;
const upstreams = ['goldsky-op', 'drpc-op', 'zan-op', 'tenderly-op'].map(id => ({id}));
for (const method of ['eth_blockNumber', 'eth_getBlockByNumber']) {
  assert.deepEqual(select(upstreams, {method}).map(u => u.id), ['goldsky-op', 'zan-op', 'tenderly-op']);
}
assert.deepEqual(select(upstreams, {method: 'eth_getTransactionReceipt'}), upstreams);
"""], check=True)

driver = (OP / "configs/driver.toml.tmpl").read_text()
assert "https://edge.goldsky.com/boost/10?key=${GOLDSKY_BOOST_KEY}" in driver
rbh = runpy.run_path(str(RBH / "assert-erpc-failclosed.py"))
source = (RBH / "configs/erpc.yaml.tmpl").read_text()
assert rbh["active_lines"](source) == rbh["EXPECTED_ACTIVE_LINES"]
for line in ("          - debug_*\n", "          - trace_*\n", "          - eth_getLogs\n",
             "          - eth_blockNumber\n", "          - eth_getBlockByNumber\n"):
    assert rbh["active_lines"](source.replace(line, "")) != rbh["EXPECTED_ACTIVE_LINES"]

for stack in (OP, RBH):
    with tempfile.TemporaryDirectory() as tmp:
        sandbox = Path(tmp)
        (sandbox / "render-configs.sh").write_text((stack / "render-configs.sh").read_text())
        (sandbox / ".env.example").write_text((stack / ".env.example").read_text())
        (sandbox / ".env").write_text("POSTGRES_USER=test\nZAN_API_KEY=test\nTENDERLY_OP_KEY=test\n")
        env = {k: v for k, v in os.environ.items() if k != "GOLDSKY_BOOST_KEY"}
        for line in (stack / ".env.example").read_text().splitlines():
            if line.startswith("ERPC_IMAGE="):
                env["ERPC_IMAGE"] = line.split("=", 1)[1]
        result = subprocess.run(["bash", str(sandbox / "render-configs.sh")], env=env,
                                capture_output=True, text=True)
        assert result.returncode == 15, (stack.name, result.stderr)
        assert "GOLDSKY_BOOST_KEY is unset/empty" in result.stderr

print("Boost RPC regression checks passed")
