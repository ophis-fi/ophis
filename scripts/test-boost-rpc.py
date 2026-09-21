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
for evm in (None, {}, {"getLogsAutoSplittingRangeThreshold": 100}, {"getLogsAutoSplittingRangeThreshold": 50, "chainId": 1}):
    bad = copy.deepcopy(config)
    bad["projects"][0]["upstreams"][2]["evm"] = evm
    assert validate(bad), "Nodies must use the proven 50-block log limit only"
for endpoint in ("https://op-pokt.nodies.app", "https://lb.nodies.app/v2/optimism?apikey=",
                 "https://lb.nodies.app/v2/ethereum?apikey=test"):
    bad = copy.deepcopy(config)
    bad["projects"][0]["upstreams"][2]["endpoint"] = endpoint
    assert validate(bad), "Do not silently use public, keyless, or wrong-chain Nodies"
for key, value in (("rateLimitCountMode", "request"), ("rateLimitBudget", ""),
                   ("creditUnits", {"*": 0}), ("rateLimitAutoTune", {"enabled": True})):
    bad = copy.deepcopy(config)
    bad["projects"][0]["upstreams"][2][key] = value
    assert validate(bad), "Nodies must not bypass or increase the shared quota cap"
bad = copy.deepcopy(config)
bad["projects"][0]["upstreams"][2]["failsafe"][0]["retry"]["maxAttempts"] = 2
assert validate(bad), "Upstream retries would spend uncounted requests"
bad = copy.deepcopy(config)
bad["rateLimiters"]["budgets"][0]["rules"][0]["maxCount"] = 181
assert validate(bad), "Do not silently raise the account budget"
bad = copy.deepcopy(config)
bad["projects"][0]["upstreams"].append(copy.deepcopy(bad["projects"][0]["upstreams"][0]))
assert validate(bad), "An extra upstream must not dilute the independent three-provider quorum"
driver = (OP / "configs/driver.toml.tmpl").read_text()
assert "edge.goldsky.com" not in driver
assert 'url = "https://lb.nodies.app/v2/optimism?apikey=${NODIES_OP_KEY}"' in driver
assert "VALIDATIONCLOUD_OP_KEY" not in driver
assert "DRPC_API_KEY" not in driver
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
        (sandbox / ".env").write_text("POSTGRES_USER=test\n")
        env = {k: v for k, v in os.environ.items() if k not in {"GOLDSKY_BOOST_KEY", "ZAN_API_KEY", "ZAN_OP_KEY", "NODIES_OP_KEY"}}
        for line in (stack / ".env.example").read_text().splitlines():
            if line.startswith("ERPC_IMAGE="):
                env["ERPC_IMAGE"] = line.split("=", 1)[1]
        result = subprocess.run(["bash", str(sandbox / "render-configs.sh")], env=env,
                                capture_output=True, text=True)
        assert result.returncode == 15, (stack.name, result.stderr)
        assert "ZAN_API_KEY is unset/empty" in result.stderr
        (sandbox / ".env").write_text("POSTGRES_USER=test\nZAN_API_KEY=test\n")
        result = subprocess.run(["bash", str(sandbox / "render-configs.sh")], env=env,
                                capture_output=True, text=True)
        assert result.returncode == 15 and "NODIES_OP_KEY is unset/empty" in result.stderr


# Connector IDs share the YAML indentation of upstream IDs but are not voters.
with tempfile.TemporaryDirectory() as tmp:
    sandbox = Path(tmp)
    (sandbox / "scripts").mkdir()
    lint = sandbox / "scripts/check-erpc-id-collisions.sh"
    lint.write_text((ROOT / "scripts/check-erpc-id-collisions.sh").read_text())
    paths = []
    for chain, upstream_id in (("optimism", "shared-op-uni"), ("unichain", "unique-uni")):
        path = sandbox / f"infra/{chain}-mainnet/configs/erpc.yaml.tmpl"
        path.parent.mkdir(parents=True)
        path.write_text("database:\n  evmJsonRpcCache:\n    connectors:\n      - id: cache\n"
                        f"projects:\n  - id: main\n    upstreams:\n      - id: {upstream_id}\n")
        paths.append(path)
    result = subprocess.run(["bash", str(lint)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    paths[1].write_text(paths[1].read_text().replace("unique-uni", "shared-op-uni"))
    result = subprocess.run(["bash", str(lint)], capture_output=True, text=True)
    assert result.returncode == 1 and "declared in both" in result.stderr, result.stderr

print("Boost RPC regression checks passed")
