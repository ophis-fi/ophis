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
for index, rule in enumerate(config["projects"][0]["networks"][0]["failsafe"]):
    if "consensus" not in rule:
        continue
    bad = copy.deepcopy(config)
    bad["projects"][0]["networks"][0]["failsafe"][index]["consensus"]["disputeBehavior"] = "preferBlockHeadLeader"
    assert validate(bad), "One surviving provider must never become authoritative"
    for field in ("maxWaitOnResult", "maxWaitOnEmpty"):
        for value in (None, "5ms", "0s", {"quantile": 0.5}):
            bad = copy.deepcopy(config)
            policy = bad["projects"][0]["networks"][0]["failsafe"][index]["consensus"]
            if value is None:
                del policy[field]
            else:
                policy[field] = value
            assert validate(bad), (index, field, value)
for method in guard["PROTECTED_METHODS"]:
    voters = [u for u in config["projects"][0]["upstreams"]
              if method not in u.get("ignoreMethods", [])
              and method in u.get("allowMethods", [method])]
    assert len(voters) == 3, (method, voters)
for key in ("allowMethods", "ignoreMethods"):
    bad = copy.deepcopy(config)
    bad["projects"][0]["upstreams"][0][key] = ["eth_getTransactionReceipt"]
    assert validate(bad), "Every OP upstream must remain eligible for all protected methods"
bad = copy.deepcopy(config)
bad["projects"][0]["networks"][0]["selectionPolicy"] = {}
assert validate(bad), "Selection policies must not silently exclude the restored voter"
bad = copy.deepcopy(config)
del bad["projects"][0]["networks"][0]["selectionPolicy"]
assert validate(bad), "Implicit policy can sideline a recovered voter"
for expression in ("upstreams.slice(0, 2)", "upstreams.filter(u => u.id !== 'drpc-op')",
                   "upstreams.sortByScore(PREFER_FASTEST)", "upstreams.removeCordoned()"):
    bad = copy.deepcopy(config)
    bad["projects"][0]["networks"][0]["selectionPolicy"]["evalFunc"] = expression
    assert validate(bad), expression
bad = copy.deepcopy(config)
bad["projects"][0]["upstreams"].append(copy.deepcopy(bad["projects"][0]["upstreams"][0]))
assert validate(bad), "An extra upstream must not dilute the independent three-provider quorum"
driver = (OP / "configs/driver.toml.tmpl").read_text()
assert "edge.goldsky.com" not in driver
assert 'url = "https://mainnet.optimism.io"' in driver
assert "${VALIDATIONCLOUD_OP_KEY}" in driver
assert "tenderly.co" not in driver
assert "GOLDSKY_BOOST_KEY" not in (OP / "render-configs.sh").read_text()
rbh = runpy.run_path(str(RBH / "assert-erpc-failclosed.py"))
source = (RBH / "configs/erpc.yaml.tmpl").read_text()
assert rbh["active_lines"](source) == rbh["EXPECTED_ACTIVE_LINES"]
for line in ("          - debug_*\n", "          - trace_*\n", "          - eth_getLogs\n",
             "              agreementThreshold: 2\n", "              maxWaitOnEmpty: 5s\n"):
    assert rbh["active_lines"](source.replace(line, "")) != rbh["EXPECTED_ACTIVE_LINES"]

for field in ("value", "input", "blockHash", "hash", "r", "s", "v"):
    assert rbh["active_lines"](source.replace("- blockTimestamp", "- " + field)) != rbh["EXPECTED_ACTIVE_LINES"]
assert rbh["active_lines"](source.replace('          - matchMethod: "eth_getTransactionByHash"\n', "")) != rbh["EXPECTED_ACTIVE_LINES"]

assert "GOLDSKY_BOOST_KEY" not in (RBH / "render-configs.sh").read_text()
assert "edge.goldsky.com" not in source
assert len(yaml.safe_load(source)["projects"][0]["upstreams"]) == 2

for stack in (OP,):
    with tempfile.TemporaryDirectory() as tmp:
        sandbox = Path(tmp)
        (sandbox / "render-configs.sh").write_text((stack / "render-configs.sh").read_text())
        (sandbox / ".env.example").write_text((stack / ".env.example").read_text())
        (sandbox / ".env").write_text("POSTGRES_USER=test\nZAN_API_KEY=test\n")
        env = {k: v for k, v in os.environ.items() if k not in {"GOLDSKY_BOOST_KEY", "VALIDATIONCLOUD_OP_KEY"}}
        for line in (stack / ".env.example").read_text().splitlines():
            if line.startswith("ERPC_IMAGE="):
                env["ERPC_IMAGE"] = line.split("=", 1)[1]
        result = subprocess.run(["bash", str(sandbox / "render-configs.sh")], env=env,
                                capture_output=True, text=True)
        assert result.returncode == 15, (stack.name, result.stderr)
        assert "VALIDATIONCLOUD_OP_KEY is unset/empty" in result.stderr

for field, value in (("method", "*"), ("params", ["latest", False]),
                     ("empty", "allow"), ("ttl", "1h")):
    bad = copy.deepcopy(config)
    bad["database"]["evmJsonRpcCache"]["policies"][1][field] = value
    assert validate(bad), (field, value)

print("Boost RPC regression checks passed")
