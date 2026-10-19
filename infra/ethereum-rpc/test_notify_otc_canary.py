import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("notify-otc-canary.sh")


class NotifyOtcCanaryTest(unittest.TestCase):
    def test_alerts_on_second_failure_and_on_recovery_with_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = root / "calls"
            curl = root / "curl"
            curl.write_text(f'#!/bin/sh\n[ -z "$FAIL_SEND" ] || exit 22\necho "$@" >> {calls}\n')
            curl.chmod(0o755)
            env_file = root / ".env"
            env_file.write_text("POSTGRES_USER=x\nTELEGRAM_BOT_TOKEN='123:abc'\nTELEGRAM_CHAT_ID=-42\n")
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", STATE_DIRECTORY=str(root),
                       CANARY_ENV_FILE=str(env_file), FAIL_SEND="")

            def run(result, fail_send=""):
                env.update(SERVICE_RESULT=result, FAIL_SEND=fail_send)
                subprocess.run(["sh", str(SCRIPT)], env=env, check=True)
                return calls.read_text().splitlines() if calls.exists() else []

            self.assertEqual(run("success"), [])
            self.assertEqual(run("exit-code"), [])
            self.assertEqual(run("exit-code", fail_send="1"), [])  # send fails: no alert recorded
            sent = run("exit-code")  # third failure retries the alert
            self.assertEqual(len(sent), 1)
            self.assertIn("bot123:abc/sendMessage", sent[0])
            self.assertIn("chat_id=-42", sent[0])
            self.assertIn("failed 3 runs in a row", sent[0])
            self.assertEqual(len(run("exit-code")), 1)  # no repeat while still failing
            self.assertEqual(len(run("success", fail_send="1")), 1)  # recovery send fails
            recovered = run("success")  # next pass retries it
            self.assertEqual(len(recovered), 2)
            self.assertIn("passing again", recovered[1])
            self.assertEqual(len(run("success")), 2)
            self.assertEqual((root / "state").read_text(), "0 0\n")


if __name__ == "__main__":
    unittest.main()
