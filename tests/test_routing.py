import unittest

import support  # noqa: F401  (puts lib on sys.path)
from taskcore.common import EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS
from taskcore.routing import decide

MET = {"state": "met", "score": 0.95}
PASSED = {"state": "passed"}


class DecideTest(unittest.TestCase):
    def test_uncovered_files_block_first(self):
        code, line, complete = decide(uncovered=["x.py", "y.py"], blocked=True)
        self.assertEqual(code, EXIT_BLOCK)
        self.assertTrue(line.startswith("ask the user: x.py, y.py not listed"))
        self.assertFalse(complete)

    def test_scope_block(self):
        code, line, _ = decide(blocked=True, unsure=["a"])
        self.assertEqual(code, EXIT_BLOCK)
        self.assertTrue(line.startswith("ask the user: show them this block"))

    def test_unsure_escalates(self):
        code, line, _ = decide(unsure=["a.py"])
        self.assertEqual(code, EXIT_ESCALATE)
        self.assertIn("not confident enough about a.py", line)

    def test_verify_changed_files_escalates(self):
        code, line, complete = decide(verify_changed=["__pycache__/x.pyc"],
                                      objectives=[("O1", MET)], verify=[("V1", PASSED)])
        self.assertEqual(code, EXIT_ESCALATE)
        self.assertTrue(line.startswith("ask the user: Verify changed __pycache__/x.pyc."))
        self.assertFalse(complete)

    def test_unchecked_before_unmet(self):
        code, line, complete = decide(objectives=[
            ("O1", {"state": "not_met", "score": 0.4}),
            ("O2", {"state": "unchecked", "reason": "too large: about 40000 tokens, limit 27200"}),
        ])
        self.assertEqual(code, EXIT_PASS)
        self.assertEqual(line, "ask the user: O2 couldn't be checked (too large: about 40000 tokens, "
                               "limit 27200). They can split it with task-goal --revise.")
        self.assertFalse(complete)

    def test_first_unmet_in_goal_order(self):
        _, line, _ = decide(objectives=[("O1", MET), ("O3", {"state": "not_met", "score": 0.62}),
                                        ("O2", {"state": "not_met", "score": 0.1})])
        self.assertEqual(line, "work on O3 (not met, 0.62)")

    def test_in_progress_before_not_started(self):
        _, line, _ = decide(objectives=[("O1", {"state": "pending"}), ("O2", {"state": "not_met", "score": 0.5})])
        self.assertEqual(line, "work on O2 (not met, 0.50)")

    def test_not_started(self):
        _, line, _ = decide(objectives=[("O1", MET), ("O2", {"state": "pending"})])
        self.assertEqual(line, "work on O2 (not started)")

    def test_failed_verify_before_couldnt_run(self):
        _, line, complete = decide(objectives=[("O1", MET)], verify=[
            ("V1", {"state": "couldnt_run", "reason": "Requires failed (exit 1): x"}),
            ("V2", {"state": "failed", "reason": "exit 1", "log": "/t/V2.log"}),
        ])
        self.assertEqual(line, "fix V2 (exit 1, log: /t/V2.log)")
        self.assertFalse(complete)

    def test_couldnt_run(self):
        _, line, complete = decide(objectives=[("O1", MET)], verify=[
            ("V1", PASSED), ("V2", {"state": "couldnt_run", "reason": "timed out after 900s"})])
        self.assertEqual(line, "ask the user: V2 couldn't run (timed out after 900s).")
        self.assertFalse(complete)

    def test_complete_with_changes(self):
        code, line, complete = decide(objectives=[("O1", MET)], verify=[("V1", PASSED)])
        self.assertEqual((code, line, complete), (EXIT_PASS, "commit; this closes the task", True))

    def test_complete_without_changes(self):
        _, line, complete = decide(objectives=[("O1", MET)], verify=[("V1", PASSED)], has_changes=False)
        self.assertEqual((line, complete), ("none: the task is complete", True))


if __name__ == "__main__":
    unittest.main()
