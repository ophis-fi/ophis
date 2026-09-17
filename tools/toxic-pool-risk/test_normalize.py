import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from normalize import ValidationError, atomic_write, normalize, parse_timestamp


NOW = datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc)
POOL = "0x1234567890aBCDef1234567890ABcdef12345678"


def scanner_output(row=None):
    rows = [] if row is None else [row]
    return {
        "chain_id": 10,
        "head_block": 139_000_000,
        "head_timestamp": int((NOW - timedelta(minutes=2)).timestamp()),
        "pool_count": len(rows),
        "rows": rows,
        "errors": [],
        "factories": [],
    }


class NormalizeTests(unittest.TestCase):
    def test_flagged_pool_is_normalized_and_hashed(self):
        feed = normalize(
            scanner_output(
                {"pool": POOL, "ui_flag": "critical", "ui_reasons": [" context dependent "]}
            ),
            expected_chain_id=10,
            now=NOW,
        )
        pool = feed["pools"][POOL.lower()]
        self.assertEqual(pool["status"], "flagged")
        self.assertEqual(pool["severity"], "critical")
        self.assertEqual(pool["reasons"], ["context dependent"])
        self.assertRegex(pool["evidenceHash"], r"^0x[0-9a-f]{64}$")
        self.assertRegex(feed["contentHash"], r"^sha256:[0-9a-f]{64}$")

    def test_row_errors_never_become_clear(self):
        feed = normalize(
            scanner_output(
                {"pool": POOL, "ui_flag": "none", "ui_reasons": [], "errors": ["decode failed"]}
            ),
            expected_chain_id=10,
            now=NOW,
        )
        self.assertEqual(feed["status"], "scan_error")
        self.assertEqual(feed["pools"][POOL.lower()]["severity"], "unknown")

    def test_rejects_wrong_chain(self):
        with self.assertRaisesRegex(ValidationError, "chain_id mismatch"):
            normalize(scanner_output(), expected_chain_id=1, now=NOW)

    def test_rejects_stale_scan(self):
        raw = scanner_output()
        raw["head_timestamp"] = int((NOW - timedelta(hours=7)).timestamp())
        with self.assertRaisesRegex(ValidationError, "stale"):
            normalize(raw, expected_chain_id=10, now=NOW)

    def test_timestamps_require_explicit_timezone_and_valid_numeric_value(self):
        for value in ("2026-07-27T12:00:00", "2026-07-27", True, False, float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                parse_timestamp(value, "head_timestamp")
        self.assertEqual(parse_timestamp("2026-07-27T14:00:00+02:00", "head_timestamp"), NOW)

    def test_expiry_is_bounded_by_scanned_head_time(self):
        raw = scanner_output()
        raw["head_timestamp"] = int((NOW - timedelta(hours=5, minutes=59)).timestamp())
        feed = normalize(raw, expected_chain_id=10, now=NOW)
        self.assertEqual(feed["expiresAt"], "2026-07-27T12:01:00Z")

    def test_rejects_falsy_non_list_top_level_errors(self):
        for malformed in ("", False, 0, {}):
            with self.subTest(malformed=malformed):
                raw = scanner_output()
                raw["errors"] = malformed
                with self.assertRaisesRegex(ValidationError, "errors must be a string array"):
                    normalize(raw, expected_chain_id=10, now=NOW)

    def test_null_or_missing_top_level_errors_default_to_empty(self):
        for raw in (scanner_output(), scanner_output()):
            raw["errors"] = None
            feed = normalize(raw, expected_chain_id=10, now=NOW)
            self.assertEqual(feed["errors"], [])
        raw = scanner_output()
        del raw["errors"]
        self.assertEqual(normalize(raw, expected_chain_id=10, now=NOW)["errors"], [])

    def test_rejects_duplicate_case_insensitive_address(self):
        row = {"pool": POOL, "ui_flag": "none", "ui_reasons": []}
        raw = scanner_output(row)
        raw["rows"].append({**row, "pool": POOL.lower()})
        raw["pool_count"] = 2
        with self.assertRaisesRegex(ValidationError, "duplicate"):
            normalize(raw, expected_chain_id=10, now=NOW)

    def test_factory_error_marks_whole_feed_incomplete(self):
        raw = scanner_output()
        raw["factories"] = [{"family": "stableswap-ng", "errors": ["log query failed"]}]
        feed = normalize(raw, expected_chain_id=10, now=NOW)
        self.assertEqual(feed["status"], "scan_error")
        self.assertEqual(feed["errors"], ["factory stableswap-ng: log query failed"])

    def test_rejects_malformed_scanner_collections(self):
        for malformed in ("", "decode failed", False, 0, {}):
            with self.subTest(malformed=malformed):
                raw = scanner_output({"pool": POOL, "ui_flag": "none", "ui_reasons": malformed})
                with self.assertRaisesRegex(ValidationError, "ui_reasons must be a string array"):
                    normalize(raw, expected_chain_id=10, now=NOW)
                raw = scanner_output()
                raw["factories"] = malformed
                with self.assertRaisesRegex(ValidationError, "factories must be an array"):
                    normalize(raw, expected_chain_id=10, now=NOW)
        with self.assertRaisesRegex(ValidationError, "unsupported ui_flag"):
            normalize(scanner_output({"pool": POOL, "ui_flag": []}), expected_chain_id=10, now=NOW)

    def test_atomic_write_produces_complete_json(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "feed.json"
            atomic_write(target, {"ok": True})
            self.assertEqual(json.loads(target.read_text()), {"ok": True})

    def test_failed_atomic_write_preserves_previous_feed_and_removes_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "feed.json"
            target.write_text('{"previous": true}\n')
            with patch("normalize.os.replace", side_effect=OSError("replacement failed")):
                with self.assertRaisesRegex(OSError, "replacement failed"):
                    atomic_write(target, {"next": True})
            self.assertEqual(json.loads(target.read_text()), {"previous": True})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_workflow_window_input_cannot_execute_shell_or_inject_environment(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/toxic-pool-monitor.yml").read_text()
        step = workflow.split("      - name: Validate configuration\n", 1)[1].split("\n      - name:", 1)[0]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        for window in ("1", "7", "183", '$(touch injected)', "7\nBASH_ENV=injected"):
            with self.subTest(window=window), tempfile.TemporaryDirectory() as directory:
                env_file = Path(directory) / "github-env"
                env = dict(os.environ, GITHUB_EVENT_NAME="workflow_dispatch", WINDOW_DAYS_INPUT=window,
                           EVENT_SCHEDULE="", RPC_URL_OPTIMISM="configured", GITHUB_ENV=str(env_file))
                result = subprocess.run(["bash", "-c", script], cwd=directory, env=env, capture_output=True)
                if window in ("1", "7", "183"):
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(env_file.read_text(), f"WINDOW_DAYS={window}\n")
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(env_file.exists())
                self.assertFalse((Path(directory) / "injected").exists())


if __name__ == "__main__":
    unittest.main()
