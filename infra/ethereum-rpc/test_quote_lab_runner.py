import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class QuoteLabRunnerTest(unittest.TestCase):
    def test_publish_on_success_and_preserve_reports_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reports = root / "reports"
            reports.mkdir()
            docker = root / "docker"
            docker.write_text("#!/bin/sh\n[ -z \"$FAIL_RPC\" ] || exit 7\nprintf '{\"cases\": []}\\n'\n")
            docker.chmod(0o755)
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", STATE_DIRECTORY=str(reports), FAIL_RPC="")
            runner = ["sh", str(Path(__file__).with_name("run-quote-lab.sh"))]
            subprocess.run(runner, env=env, check=True, capture_output=True)
            files = list(reports.glob("*.json"))
            self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text()), {"cases": []})
            env["FAIL_RPC"] = "1"
            self.assertEqual(subprocess.run(runner, env=env, capture_output=True).returncode, 7)
            self.assertEqual(list(reports.iterdir()), files)


if __name__ == "__main__":
    unittest.main()
