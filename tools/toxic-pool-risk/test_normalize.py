import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from normalize import ValidationError, atomic_write, normalize


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

    def test_atomic_write_produces_complete_json(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "feed.json"
            atomic_write(target, {"ok": True})
            self.assertEqual(json.loads(target.read_text()), {"ok": True})


if __name__ == "__main__":
    unittest.main()
