#!/usr/bin/env python3
"""Task Goal: write, check and record the goal a task-contract task executes.

Structure is checked in plain code. Wording is judged by Jev. Tunables live in
config.json at the repository root.

Modes (goal text on stdin, verbatim):
  --check                 Check a draft. Creates nothing.
  --record --slug <slug>  Record a goal the user approved word for word. Creates a ready task.
  --revise                Record a new version the user approved word for word.

Exit codes:
  0  ready / recorded
  2  escalate to the user
  3  not ready, or a precondition failed
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))

from taskcore import clarity, config, goalfmt, jev, tasks  # noqa: E402
from taskcore.common import EXIT_PASS, EXIT_PRECONDITION, die, now, out, read_stdin, run, text_hash  # noqa: E402
from taskcore.gitutil import git, git_root  # noqa: E402

CHECK_PATH = Path(__file__).resolve().parents[2] / "task-contract" / "scripts" / "check.py"


def structure(text, root):
    """(goal, notes) or stop with every structural error. Plain code only."""
    goal, errors = goalfmt.parse(text)
    if root is not None and goal.repo and goal.repo != root.name:
        errors.append(f"Repo: says '{goal.repo}', but this repository is '{root.name}'. "
                      "A task covers one repository.")
    if errors:
        die(EXIT_PRECONDITION,
            "NOT READY: the goal does not follow the format. Nothing was sent to Jev.",
            *[f"  - {e}" for e in errors])
    notes = []
    if root is not None:
        _, tracked = git(root, "ls-files")
        existing = set(tracked.splitlines())
        for objective in goal.objectives:
            for pattern in objective.files:
                if any(c in pattern for c in "*?") or pattern.endswith("/"):
                    if not any(goalfmt.matches(pattern, p) for p in existing):
                        notes.append(f"{objective.id}: '{pattern}' matches no tracked file yet.")
                elif not (root / pattern).exists():
                    notes.append(f"{objective.id}: '{pattern}' does not exist yet (fine if the task creates it).")
    return goal, notes


def optional_root():
    rc, top = git(None, "rev-parse", "--show-toplevel")
    return Path(top.strip()) if rc == 0 and top.strip() else None


def cmd_check(args):
    text = read_stdin()
    if not text:
        die(EXIT_PRECONDITION, "PRECONDITION FAILED: no goal on stdin.")
    root = optional_root()
    goal, notes = structure(text, root)
    ok, report, _ = clarity.check(text, goal)
    out(("READY" if ok else "NOT READY") + f": {len(goal.objectives)} objectives, "
        f"{len(goal.rules)} rules, {len(goal.out_of_scope)} out of scope, {len(goal.verify)} verify.",
        *report,
        *(["", "Notes:"] + [f"  {n}" for n in notes] if notes else []),
        "" if root else "Not inside a git repository: Repo: and Files: were not checked against it.")
    if not ok:
        out("Show the user what is not ready. Record nothing until they approve new wording.")
        return EXIT_PRECONDITION
    out("Show the user the full goal. Record it only after they approve this exact text:",
        "  goal.py --record --slug <slug>")
    return EXIT_PASS


def cmd_record(args):
    root = git_root()
    text = read_stdin()
    if not text:
        die(EXIT_PRECONDITION, "PRECONDITION FAILED: no goal on stdin.",
            "Pipe the goal the user approved, verbatim.")
    open_tasks = tasks.find(root)
    if open_tasks:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: this repository already has an open task.",
            "To change its goal, use goal.py --revise. To start over, the user closes it first (check.py --close).",
            *[f"  {t}" for t in open_tasks])
    goal, notes = structure(text, root)
    ok, report, results = clarity.check(text, goal)
    if not ok:
        die(EXIT_PRECONDITION, "NOT READY: nothing was recorded.", *report)

    slug = tasks.slugify(args.slug) or tasks.slugify(goal.title)
    if not slug:
        die(EXIT_PRECONDITION, "PRECONDITION FAILED: --slug produced an empty name.")
    task = tasks.create(root, slug, datetime.now().strftime("%Y-%m-%d"))
    goal_text = text + "\n"
    tasks.write_goal(task, goal_text, 1, goal)
    tasks.write_meta(task, {
        "id": task.name,
        "slug": slug,
        "repo": str(root),
        "base_commit": None,
        "goal_version": 1,
        "goal_hash": text_hash(goal_text),
        "retired_ids": [],
        "config_hash": config.config_hash(),
        "config": dict(config.CFG),
        "created": now(),
        "status": "ready",
    })
    tasks.write_state(task, tasks.fresh_state(goal))
    tasks.event(task, "record", version=1, clarity=results, notes=notes)
    out(f"RECORDED  {task.name}",
        *report,
        *(["", "Notes:"] + [f"  {n}" for n in notes] if notes else []),
        "",
        f"Goal:  {task / 'goal.md'}",
        "The task is ready. Start it with task-contract:",
        f"  python3 {CHECK_PATH} --start")
    return EXIT_PASS


def cmd_revise(args):
    root = git_root()
    task = tasks.resolve(root)
    meta = tasks.read_meta(task)
    tasks.verified_config(task, meta)
    text = read_stdin()
    if not text:
        die(EXIT_PRECONDITION, "PRECONDITION FAILED: no goal on stdin.",
            "Pipe the complete new version the user approved, verbatim.")
    version = meta["goal_version"]
    old_text = (task / f"goal.v{version}.md").read_text()
    if text + "\n" == old_text:
        if (task / "goal.md").read_text() != old_text:
            tasks.write_goal(task, old_text, version, goalfmt.parse(old_text)[0])
            out("goal.md was restored to the recorded version. Nothing else changed.")
        else:
            out("Nothing changed: this is the recorded version.")
        return EXIT_PASS
    old, _ = goalfmt.parse(old_text)
    goal, notes = structure(text, root)
    reused = [i for i in goal.ids() if i in meta.get("retired_ids", [])]
    if reused:
        die(EXIT_PRECONDITION,
            "NOT READY: these IDs were removed in an earlier version and are never reused:",
            f"  {', '.join(reused)}",
            "Give the new items new numbers.")
    changes = goalfmt.compare(old, goal) or ["wording outside the items changed"]
    ok, report, results = clarity.check(text, goal)
    if not ok:
        tasks.event(task, "revise-reject", version=version + 1, changes=changes, clarity=results)
        die(EXIT_PRECONDITION, "NOT READY: the new version was not recorded.", *report)

    version += 1
    goal_text = text + "\n"
    tasks.write_goal(task, goal_text, version, goal)
    removed = [c.split()[0] for c in changes if c.endswith(" removed")]
    touched = {c.split()[0] for c in changes if c.endswith((" changed", " added"))}
    state = tasks.read_state(task)
    for group in ("objectives", "verify"):
        for oid in touched:
            state.get(group, {}).pop(oid, None)
    tasks.write_state(task, tasks.fresh_state(goal, state))
    meta.update(goal_version=version, goal_hash=text_hash(goal_text),
                retired_ids=sorted(set(meta.get("retired_ids", [])) | set(removed)))
    tasks.write_meta(task, meta)
    tasks.event(task, "revise", version=version, changes=changes, clarity=results, notes=notes)
    out(f"REVISED  {task.name}  now version {version}",
        *[f"  {c}" for c in changes],
        *report,
        *(["", "Notes:"] + [f"  {n}" for n in notes] if notes else []),
        "",
        "Any earlier pass is void, and changed objectives are checked again.",
        f"Goal: {task / 'goal.md'}")
    return EXIT_PASS


def main():
    parser = argparse.ArgumentParser(add_help=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--record", action="store_true")
    modes.add_argument("--revise", action="store_true")
    parser.add_argument("--slug", default="")
    parser.add_argument("--session", default="")
    args = parser.parse_args()
    jev.SESSION = args.session
    config.load()
    if args.check:
        return cmd_check(args)
    if args.record:
        return cmd_record(args)
    return cmd_revise(args)


if __name__ == "__main__":
    run(main)
