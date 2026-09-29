import tempfile
import unittest
from pathlib import Path

import support  # noqa: F401  (puts lib on sys.path)
from taskcore.goalfmt import Check
from taskcore.verify import run_check


class RunCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.logs = self.root / "verify"

    def tearDown(self):
        self.tmp.cleanup()

    def run_one(self, command, requires="", timeout=10):
        return run_check(Check("V1", command, requires), self.root, self.logs, timeout, 5)

    def test_passed_writes_no_log(self):
        result = self.run_one("true")
        self.assertEqual((result["state"], result["exit"]), ("passed", 0))
        self.assertNotIn("log", result)
        self.assertFalse(self.logs.exists())

    def test_failed_keeps_output(self):
        result = self.run_one("echo boom; exit 3")
        self.assertEqual((result["state"], result["reason"]), ("failed", "exit 3"))
        self.assertIn("boom", Path(result["log"]).read_text())

    def test_missing_command_couldnt_run(self):
        result = self.run_one("definitely-not-a-command-4821")
        self.assertEqual(result["state"], "couldnt_run")
        self.assertEqual(result["reason"], "command not found (exit 127)")

    def test_requires_failure_skips_command(self):
        result = self.run_one("touch ran", requires="false")
        self.assertEqual(result["state"], "couldnt_run")
        self.assertEqual(result["reason"], "Requires failed (exit 1): false")
        self.assertFalse((self.root / "ran").exists())

    def test_requires_success_runs_command(self):
        result = self.run_one("touch ran", requires="true")
        self.assertEqual(result["state"], "passed")
        self.assertTrue((self.root / "ran").exists())

    def test_timeout_couldnt_run(self):
        result = self.run_one("sleep 5", timeout=1)
        self.assertEqual((result["state"], result["reason"]), ("couldnt_run", "timed out after 1s"))
        self.assertLess(result["seconds"], 4)


if __name__ == "__main__":
    unittest.main()
