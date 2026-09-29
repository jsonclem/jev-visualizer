"""Test helpers: a fake Jev, a throwaway git repository, and in-process script runs."""

import contextlib
import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

from taskcore import common, config, jev  # noqa: E402

GOAL_SCRIPT = ROOT / "skills" / "task-goal" / "scripts" / "goal.py"
CHECK_SCRIPT = ROOT / "skills" / "task-contract" / "scripts" / "check.py"


def load_script(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_post(state, questions):
    """Deterministic stand-in for Jev.

    Goal checks pass. Scope is outside_scope when the diff contains EXTRA. An
    objective is met when its diff contains DONE.
    """
    answers = {}
    for key, question in questions.items():
        kind = question["type"]
        if kind == "score":
            answers[key] = {"type": "score", "score": 3.0, "confidence": 0.95}
        elif kind == "choice":
            choice = "outside_scope" if "EXTRA" in state.get("diff", "") else "within_scope"
            answers[key] = {"type": "choice", "choice": choice, "confidence": 0.95}
        elif key == "met":
            answers[key] = {"type": "noul", "noul": 0.95 if "DONE" in state["diff"] else 0.30}
        else:
            answers[key] = {"type": "noul", "noul": 0.05}
    return answers, "fake"


class TaskTest(unittest.TestCase):
    """A temporary git repository named `demo`, a temporary history folder, and the fake Jev."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.repo = base / "demo"
        self.repo.mkdir()
        self.history = base / "history"
        self.history.mkdir()
        self.patches = [
            (common, "TASKS_DIR", self.history),
            (common, "ENV_FILE", self.history / ".env"),
            (jev, "post", fake_post),
        ]
        self.saved = [(obj, name, getattr(obj, name)) for obj, name, _ in self.patches]
        for obj, name, value in self.patches:
            setattr(obj, name, value)
        jev.CURRENT_TASK = None
        jev.RECORDS.clear()
        config.load()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "commit.gpgsign", "false")
        self.write("a.txt", "a\n")
        self.write("b.txt", "b\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "Initial")
        self.goal_script = load_script(GOAL_SCRIPT, "goal_script")
        self.check_script = load_script(CHECK_SCRIPT, "check_script")

    def tearDown(self):
        for obj, name, value in self.saved:
            setattr(obj, name, value)
        jev.CURRENT_TASK = None
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args],
                              check=True, capture_output=True, text=True).stdout

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_script(self, module, *argv, stdin=""):
        """(exit code, output) from a script's main(), run in the test repository."""
        buffer = io.StringIO()
        old_argv, old_stdin, old_cwd = sys.argv, sys.stdin, Path.cwd()
        sys.argv = ["script", *argv]
        sys.stdin = io.StringIO(stdin)
        try:
            import os
            os.chdir(self.repo)
            with contextlib.redirect_stdout(buffer):
                try:
                    code = module.main()
                except common.Stop as stop:
                    common.out(*stop.lines)
                    code = stop.code
        finally:
            sys.argv, sys.stdin = old_argv, old_stdin
            os.chdir(old_cwd)
        return code, buffer.getvalue()

    def goal(self, *argv, stdin=""):
        return self.run_script(self.goal_script, *argv, stdin=stdin)

    def check(self, *argv):
        return self.run_script(self.check_script, *argv)

    def task(self):
        folders = [p for p in self.history.iterdir() if p.is_dir() and not p.name.startswith("_")]
        self.assertEqual(len(folders), 1)
        return folders[0]


GOAL = """\
# Demo task
Repo: demo
A small task for tests.

## Objectives

### O1 First file
Files: a.txt
a.txt says DONE.

### O2
Files: b.txt, docs/
b.txt says DONE.

## Rules
- R1: Keep each file to one line.

## Out of scope
- X1: The README.

## Verify
- V1: grep -q DONE a.txt && grep -q DONE b.txt
"""
