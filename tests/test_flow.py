import json
import unittest

from support import GOAL, TaskTest
from taskcore import gate, goalfmt, jev, tasks
from taskcore.common import EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS, EXIT_PRECONDITION


def events(task):
    return [json.loads(line) for line in (task / "events.jsonl").read_text().splitlines()]


class GoalScriptTest(TaskTest):
    def test_check_creates_nothing(self):
        code, output = self.goal("--check", stdin=GOAL)
        self.assertEqual(code, EXIT_PASS, output)
        self.assertIn("READY: 2 objectives, 1 rules, 1 out of scope, 1 verify.", output)
        self.assertEqual([p for p in self.history.iterdir() if not p.name.startswith("_")], [])

    def test_structure_errors_never_reach_jev(self):
        calls = []
        jev.post = lambda state, questions: calls.append(1)
        code, output = self.goal("--check", stdin=GOAL.replace("Files: a.txt\n", ""))
        self.assertEqual(code, EXIT_PRECONDITION)
        self.assertIn("Nothing was sent to Jev", output)
        self.assertEqual(calls, [])

    def test_wrong_repo_rejected(self):
        code, output = self.goal("--check", stdin=GOAL.replace("Repo: demo", "Repo: other"))
        self.assertEqual(code, EXIT_PRECONDITION)
        self.assertIn("this repository is 'demo'", output)

    def test_record_writes_task_folder(self):
        code, output = self.goal("--record", "--slug", "demo", stdin=GOAL)
        self.assertEqual(code, EXIT_PASS, output)
        task = self.task()
        meta = tasks.read_meta(task)
        self.assertEqual((meta["status"], meta["goal_version"]), ("ready", 1))
        self.assertEqual((task / "goal.md").read_text(), GOAL)
        self.assertEqual((task / "goal.v1.md").read_text(), GOAL)
        self.assertEqual(json.loads((task / "goal.json").read_text())["objectives"][0]["id"], "O1")
        state = tasks.read_state(task)
        self.assertEqual(state["objectives"]["O1"]["state"], "pending")
        self.assertEqual([e["event"] for e in events(task)], ["record"])
        self.assertTrue((task / "jev.jsonl").read_text())

        code, output = self.goal("--record", "--slug", "again", stdin=GOAL)
        self.assertEqual(code, EXIT_PRECONDITION)
        self.assertIn("already has an open task", output)

    def test_revise_tracks_ids(self):
        self.goal("--record", "--slug", "demo", stdin=GOAL)
        revised = GOAL.replace("b.txt says DONE.", "b.txt says DONE, in capitals.").replace(
            "### O1 First file\nFiles: a.txt\na.txt says DONE.\n\n", "")
        code, output = self.goal("--revise", stdin=revised)
        self.assertEqual(code, EXIT_PASS, output)
        self.assertIn("O2 changed", output)
        self.assertIn("O1 removed", output)
        task = self.task()
        meta = tasks.read_meta(task)
        self.assertEqual((meta["goal_version"], meta["retired_ids"]), (2, ["O1"]))
        self.assertEqual(list(tasks.read_state(task)["objectives"]), ["O2"])

        code, output = self.goal("--revise", stdin=revised.replace("### O2", "### O1"))
        self.assertEqual(code, EXIT_PRECONDITION)
        self.assertIn("never reused", output)

    def test_hand_edited_goal_stops_the_gate(self):
        self.goal("--record", "--slug", "demo", stdin=GOAL)
        self.check("--start")
        goal_md = self.task() / "goal.md"
        goal_md.chmod(0o644)
        goal_md.write_text(GOAL + "\n")
        self.write("a.txt", "DONE\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_PRECONDITION)
        self.assertIn("goal.md changed outside the scripts", output)


class ContractFlowTest(TaskTest):
    def start(self, goal=GOAL):
        code, output = self.goal("--record", "--slug", "demo", stdin=goal)
        self.assertEqual(code, EXIT_PASS, output)
        code, output = self.check("--start")
        self.assertEqual(code, EXIT_PASS, output)
        return output

    def test_gate_requires_start(self):
        self.goal("--record", "--slug", "demo", stdin=GOAL)
        code, output = self.check()
        self.assertEqual(code, EXIT_PRECONDITION)
        self.assertIn("is ready, not started", output)

    def test_full_task_reaches_complete(self):
        output = self.start()
        self.assertIn("NEXT: work on O1 (not started)", output)

        self.write("a.txt", "DONE\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_PASS, output)
        self.assertIn("✓ O1", output)
        self.assertIn("◇ O2", output)
        self.assertIn("NEXT: work on O2 (not started)", output)
        code, output = self.check("--commit", "-m", "Mark a done")
        self.assertEqual(code, EXIT_PASS, output)
        self.assertIn("NEXT: work on O2 (not started)", output)

        self.write("b.txt", "DONE\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_PASS, output)
        self.assertIn("✓ V1", output)
        self.assertIn("NEXT: commit; this closes the task", output)
        code, output = self.check("--commit", "-m", "Mark b done")
        self.assertIn("GOAL COMPLETE. The task is closed.", output)
        task = self.task()
        self.assertEqual(tasks.read_meta(task)["status"], "complete")
        self.assertEqual([e["event"] for e in events(task)][-2:], ["commit", "complete"])

    def test_objective_result_is_reused(self):
        self.start()
        self.write("a.txt", "DONE\n")
        self.check()
        self.check("--commit", "-m", "Mark a done")
        asked = []
        real = jev.post
        jev.post = lambda state, questions: asked.append(state) or real(state, questions)
        self.write("b.txt", "not yet\n")
        self.check()
        completion = [s for s in asked if "objective" in s]
        self.assertEqual([s["objective"].splitlines()[0].split(":")[0] for s in completion], ["O2"])

    def test_uncovered_file_blocks_without_jev(self):
        self.start()
        asked = []
        jev.post = lambda state, questions: asked.append(1)
        self.write("README.md", "hi\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_BLOCK, output)
        self.assertIn("NEXT: ask the user: README.md not listed", output)
        self.assertEqual(asked, [])
        code, output = self.check("--commit", "-m", "Sneak it in")
        self.assertEqual(code, EXIT_PRECONDITION)

    def test_scope_block(self):
        self.start()
        self.write("a.txt", "DONE EXTRA\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_BLOCK, output)
        self.assertIn("BLOCKED: this change contains work the goal does not ask for.", output)
        self.assertEqual(tasks.read_state(self.task())["last_pass"], None)

    def test_low_confidence_escalates(self):
        self.start()
        real = jev.post

        def unsure(state, questions):
            answers, model = real(state, questions)
            if "verdict" in answers:
                answers["verdict"]["confidence"] = 0.3
            return answers, model
        jev.post = unsure
        self.write("a.txt", "DONE\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_ESCALATE, output)
        self.assertIn("NEXT: ask the user: Jev is not confident enough about a.txt", output)

    def test_failing_verify_points_at_log(self):
        self.start(GOAL.replace("grep -q DONE a.txt && grep -q DONE b.txt", "echo nope; exit 1"))
        self.write("a.txt", "DONE\n")
        self.write("b.txt", "DONE\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_PASS, output)
        self.assertIn("✗ V1", output)
        self.assertIn("NEXT: fix V1 (exit 1, log: ", output)
        self.assertIn("GOAL NOT YET COMPLETE.", output)

    def test_verify_that_writes_files_escalates(self):
        self.start(GOAL.replace("grep -q DONE a.txt && grep -q DONE b.txt", "touch generated.txt"))
        self.write("a.txt", "DONE\n")
        self.write("b.txt", "DONE\n")
        code, output = self.check()
        self.assertEqual(code, EXIT_ESCALATE, output)
        self.assertIn("NEXT: ask the user: Verify changed generated.txt.", output)
        code, output = self.check("--commit", "-m", "Finish both")
        self.assertEqual(code, EXIT_PRECONDITION)

    def test_verify_rerun_on_committed_work(self):
        self.start(GOAL.replace("grep -q DONE a.txt && grep -q DONE b.txt",
                                "grep -q DONE a.txt\n  Requires: test -f ready"))
        self.write("a.txt", "DONE\n")
        self.write("b.txt", "DONE\n")
        code, output = self.check()
        self.assertIn("NEXT: ask the user: V1 couldn't run (Requires failed (exit 1): test -f ready).", output)
        self.check("--commit", "-m", "Finish both")
        (self.repo / ".git" / "info" / "exclude").write_text("ready\n")
        self.write("ready", "")
        code, output = self.check()
        self.assertEqual(code, EXIT_PASS, output)
        self.assertIn("NO NEW CHANGES", output)
        self.assertIn("GOAL COMPLETE. The task is closed.", output)
        self.assertEqual(tasks.read_meta(self.task())["status"], "complete")

    def test_too_large_objective_is_unchecked(self):
        self.start()
        self.write("a.txt", "DONE\n")
        goal, _ = goalfmt.parse(GOAL)
        tree = self.git("rev-parse", "HEAD^{tree}").strip()
        self.git("add", "-A")
        staged = self.git("write-tree").strip()
        real = jev.request_tokens
        jev.request_tokens = lambda state, questions: 10 ** 6
        try:
            records = gate.completion(self.repo, goal, self.git("rev-parse", "HEAD").strip(), staged, {})
        finally:
            jev.request_tokens = real
        self.assertNotEqual(tree, staged)
        self.assertEqual(records["O1"]["state"], "unchecked")
        self.assertTrue(records["O1"]["reason"].startswith("too large: about 1000000 tokens"))
        self.assertEqual(records["O2"]["state"], "pending")

    def test_close(self):
        self.start()
        code, output = self.check("--close")
        self.assertEqual(code, EXIT_PASS, output)
        self.assertEqual(tasks.read_meta(self.task())["status"], "closed")


if __name__ == "__main__":
    unittest.main()
