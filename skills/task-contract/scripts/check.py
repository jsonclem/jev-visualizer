#!/usr/bin/env python3
"""Task Contract gate.

Jev decides judgments. This script decides facts and what happens next. The
goal is recorded by task-goal (goal.py); tunables live in config.json at the
repository root.

Modes:
  --start                 Start the ready task for this repository, or resume the active one.
  (no arguments)          Gate the change, check each objective, run Verify, print NEXT.
  --commit -m <message>   Commit the gated change locally. Never pushes.
  --accept-config         Accept config.json values the user changed mid-task.
  --close                 Close the open task without completing it.
  --hook                  pre-commit hook entry point. Not for direct use.

Exit codes:
  0  pass; follow the NEXT line after committing
  1  blocked; the user decides whether to revert
  2  escalate to the user
  3  precondition failed
"""

import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))

from taskcore import config, gate, goalfmt, jev, routing, tasks  # noqa: E402
from taskcore.common import (  # noqa: E402
    EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS, EXIT_PRECONDITION, die, now, out, run,
)
from taskcore.config import CFG  # noqa: E402
from taskcore.gitutil import (  # noqa: E402
    changed_paths, git, git_root, head_sha, head_tree, reachable, require_clean,
    snapshot, uses_conventional_commits,
)

CHECK_PATH = Path(__file__).resolve()
COMMIT_ENV = "TASK_CONTRACT_COMMIT"    # set by --commit to the gated tree; the hook requires it

MARK = {"met": "✓", "not_met": "✗", "unchecked": "⊘", "pending": "◇",
        "passed": "✓", "failed": "✗", "couldnt_run": "⊘"}


def open_task(root, statuses=("active",)):
    task = tasks.resolve(root, tasks.ACTIVE)
    meta = tasks.read_meta(task)
    if meta["status"] not in statuses:
        die(EXIT_PRECONDITION,
            f"PRECONDITION FAILED: task {meta['id']} is {meta['status']}, not started.",
            f"Start it with: python3 {CHECK_PATH} --start")
    return task, meta


def objective_lines(goal, records):
    lines = []
    for objective in goal.objectives:
        record = records.get(objective.id, {"state": "pending"})
        state = record["state"]
        if state in ("met", "not_met"):
            detail = f"{'met' if state == 'met' else 'not met':<8} {record['score']:.2f}"
        elif state == "unchecked":
            detail = f"couldn't check: {record.get('reason')}"
        else:
            detail = f"not started ({record.get('reason', 'no changes yet')})"
        lines.append(f"  {MARK[state]} {objective.id:<4} {detail}")
    return lines


def verify_lines(goal, records):
    lines = []
    for check in goal.verify:
        record = records.get(check.id, {"state": "pending"})
        state = record["state"]
        if state == "passed":
            detail = f"passed ({record.get('seconds', 0)}s)"
        elif state == "failed":
            detail = f"failed: {record.get('reason')}  log: {record.get('log')}"
        elif state == "couldnt_run":
            detail = f"couldn't run: {record.get('reason')}" + (f"  log: {record['log']}" if record.get("log") else "")
        else:
            detail = record.get("reason", "not run")
        lines.append(f"  {MARK[state]} {check.id:<4} {detail}")
    return lines


# --- Modes --------------------------------------------------------------------

def cmd_start(args):
    root = git_root()
    task = tasks.resolve(root)
    meta = tasks.read_meta(task)
    _, goal = tasks.load_goal(task, meta)
    tasks.verified_config(task, meta)
    state = tasks.read_state(task)

    if meta["status"] == "ready":
        require_clean(root)
        sha = head_sha(root)
        meta.update(status="active", base_commit=sha, started=now())
        tasks.write_meta(task, meta)
        first = goal.objectives[0].id
        state["next"] = f"work on {first} (not started)"
        tasks.write_state(task, state)
        hook_note = tasks.install_hook(root, CHECK_PATH)
        tasks.event(task, "start", base=sha, version=meta["goal_version"])
        out(f"STARTED  {task.name}",
            f"Goal:    {task / 'goal.md'}  (version {meta['goal_version']})",
            f"Base:    {sha}",
            hook_note,
            config.handoff_line(),
            "",
            "Objectives:", *objective_lines(goal, state["objectives"]),
            "",
            f"NEXT: {state['next']}")
        return EXIT_PASS

    base_note = "" if reachable(root, meta.get("base_commit", "")) else "  (base commit no longer reachable)"
    pending = ""
    tree = snapshot(root)
    if tree != head_tree(root):
        pending = ("passed the gate, not yet committed" if tree == state.get("last_pass")
                   else "not yet gated; run check.py before committing")
    tasks.event(task, "resume", head=head_sha(root), uncommitted=pending or None)
    out(f"RESUMED  {task.name}",
        f"Goal:    {task / 'goal.md'}  (version {meta['goal_version']})",
        f"Base:    {meta.get('base_commit')}{base_note}",
        config.handoff_line(),
        *([f"Uncommitted changes: {pending}"] if pending else []),
        "",
        "Objectives:", *objective_lines(goal, state.get("objectives", {})),
        "Verify:", *verify_lines(goal, state.get("verify", {})),
        "",
        f"NEXT: {state.get('next') or 'run check.py on your next change'}")
    return EXIT_PASS


def cmd_gate(args):
    root = git_root()
    task, meta = open_task(root)
    _, goal = tasks.load_goal(task, meta)
    tasks.verified_config(task, meta)
    state = tasks.read_state(task)
    base = meta["base_commit"]

    tree = snapshot(root)
    head = head_sha(root)
    has_changes = tree != head_tree(root)
    if not has_changes and head == base:
        tasks.event(task, "gate", result="escalate", reason="no-changes")
        die(EXIT_ESCALATE,
            "ESCALATE: there are no changes to check.",
            "Nothing was committed.",
            f"NEXT: {state.get('next') or 'make a change toward the first objective'}, then run check.py")

    record = {"tree": tree, "head": head, "has_changes": has_changes, "version": meta["goal_version"]}
    lines = []

    if has_changes:
        uncovered = goalfmt.uncovered(goal, changed_paths(root, "HEAD", tree))
        if uncovered:
            return stop(task, state, record, ["BLOCKED: files changed that no objective lists.",
                                              *[f"  {p}" for p in uncovered]],
                        uncovered=uncovered)

        results = gate.scope(root, goal, tree, head)
        blocked, tripped, unsure, drift = gate.judge_scope(results)
        record.update(scope=results, drift=drift)
        lines = ["Scope:",
                 *[f"  {r['path']}  {r['verdict']} ({r['confidence']:.2f})" for r in results],
                 *[f"  {k:<16} {v:.2f}  (max)" for k, v in drift.items()]]
        if blocked or tripped:
            record.update(blocked=blocked, tripped=tripped)
            return stop(task, state, record,
                        ["BLOCKED: this change contains work the goal does not ask for.", *lines,
                         *(["Tripped: " + ", ".join(f"{k} {v:.2f}" for k, v in sorted(tripped.items()))]
                           if tripped else [])],
                        blocked=True)
        if unsure:
            record.update(unsure=unsure)
            return stop(task, state, record,
                        ["ESCALATE: Jev is not confident enough to gate this automatically.", *lines,
                         "Nothing was committed. The user decides."],
                        unsure=unsure)

    objectives = gate.completion(root, goal, base, tree, state.get("objectives", {}))
    if all(r["state"] == "met" for r in objectives.values()):
        checks = gate.run_verify(root, goal, tree, state.get("verify", {}), task / "verify")
        after = snapshot(root)
        if after != tree:
            # The gate checked `tree`; committing `after` would commit files nobody checked.
            changed = changed_paths(root, tree, after)
            record.update(objectives=objectives, verify=checks, verify_changed=changed)
            return stop(task, state, record,
                        ["ESCALATE: the Verify commands changed files in the repository.",
                         *[f"  {p}" for p in changed],
                         "Nothing was committed. The user decides."],
                        verify_changed=changed)
    else:
        checks = gate.waiting_verify(goal)
    code, next_line, complete = routing.decide(
        objectives=[(o.id, objectives[o.id]) for o in goal.objectives],
        verify=[(c.id, checks[c.id]) for c in goal.verify],
        has_changes=has_changes)

    state.update(objectives=objectives, verify=checks, next=next_line,
                 last_pass=tree if has_changes else None,
                 last_pass_complete=complete and has_changes)
    tasks.write_state(task, state)
    record.update(result="pass", objectives=objectives, verify=checks, complete=complete,
                  next=next_line, exit=code)
    tasks.event(task, "gate", **record)
    if complete and not has_changes:
        meta.update(status="complete", closed=now())
        tasks.write_meta(task, meta)
        tasks.event(task, "complete", head=head)

    met = sum(r["state"] == "met" for r in objectives.values())
    out("PASS: this change is within the recorded goal." if has_changes
        else f"NO NEW CHANGES: checked the committed work at {head}.",
        *lines,
        "",
        f"Objectives ({met}/{len(goal.objectives)} met):", *objective_lines(goal, objectives),
        "Verify:", *verify_lines(goal, checks),
        "",
        ("GOAL COMPLETE. The task is closed." if complete and not has_changes
         else "GOAL COMPLETE once committed." if complete else "GOAL NOT YET COMPLETE."),
        *([f'Commit it with: check.py --commit -m "<message>"'] if has_changes else []),
        f"NEXT: {next_line}")
    return code


def stop(task, state, record, lines, **why):
    """A blocked or escalated gate: nothing passes, and NEXT goes to the user."""
    code, next_line, _ = routing.decide(**why)
    state.update(last_pass=None, last_pass_complete=False, next=next_line)
    tasks.write_state(task, state)
    record.update(result="block" if code == EXIT_BLOCK else "escalate", next=next_line, exit=code,
                  **{k: v for k, v in why.items() if k == "uncovered"})
    tasks.event(task, "gate", **record)
    if code == EXIT_BLOCK:
        lines += ["", "Do not revert on your own. Show this to the user and ask.",
                  f"If they approve, revert with: {routing.REVERT}", "(Recoverable: git stash pop.)"]
    out(*lines, f"Goal: {task / 'goal.md'}", f"NEXT: {next_line}")
    return code


BAD_PREFIX = re.compile(
    r"^\s*(claude|codex|gpt|chatgpt|copilot|cursor|ai|bot|agent|assistant)\b[\s:>\-–—]+",
    re.IGNORECASE,
)
BAD_TRAILER = re.compile(
    r"^\s*(co-authored-by\s*:|generated with|created by (claude|codex|an? ai))",
    re.IGNORECASE,
)
CONVENTIONAL = re.compile(r"^\w+(\([^)]*\))?!?: ")
EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF️✅❌]")


def sanitize_message(message, allow_conventional):
    """Message format is a fact, so it is enforced here rather than trusted."""
    lines = [line for line in message.strip().splitlines()]
    kept = [line for line in lines if not BAD_TRAILER.match(line)]
    subject = kept[0].strip() if kept else ""

    previous = None
    while subject != previous:
        previous = subject
        subject = BAD_PREFIX.sub("", subject).strip()
    subject = EMOJI.sub("", subject).strip()

    if not allow_conventional:
        subject = CONVENTIONAL.sub("", subject).strip()

    subject = re.sub(r"\s+", " ", subject).rstrip(".").strip()
    if subject and subject[0].islower() and not CONVENTIONAL.match(subject):
        subject = subject[0].upper() + subject[1:]
    limit = CFG["commits.max_subject_chars"]
    if len(subject) > limit:
        subject = subject[:limit].rsplit(" ", 1)[0].rstrip(",;:-")

    body = [line for line in kept[1:] if not EMOJI.search(line)]
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    return subject, body


def cmd_commit(args):
    root = git_root()
    task, meta = open_task(root)
    tasks.load_goal(task, meta)
    state = tasks.read_state(task)

    tree = snapshot(root)
    if tree == head_tree(root):
        die(EXIT_ESCALATE, "ESCALATE: there is nothing to commit.")
    if tree != state.get("last_pass"):
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: no passing gate for the current changes.",
            "Run check.py with no arguments and act on its exit code.",
            "Nothing was committed.")

    subject, body = sanitize_message(args.message, uses_conventional_commits(root))
    if not subject:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: nothing usable left in the commit message.",
            "Write a short, plain subject line describing the change.")

    git(root, "add", "-A", check=True)
    _, staged = git(root, "write-tree", check=True)
    if staged.strip() != tree:
        die(EXIT_ESCALATE,
            "ESCALATE: the files changed while committing. Nothing was committed.",
            "Run check.py again.")
    full = subject if not body else subject + "\n\n" + "\n".join(body)
    rc, _ = git(root, "commit", "-m", full, env={**os.environ, COMMIT_ENV: tree})
    if rc != 0:
        die(EXIT_ESCALATE, "ESCALATE: git commit failed. Nothing was committed.")

    complete = state.get("last_pass_complete", False)
    state.update(last_pass=None, last_pass_complete=False)
    tasks.write_state(task, state)
    sha = head_sha(root)
    tasks.event(task, "commit", sha=sha, subject=subject, tree=tree)
    out(f"COMMITTED  {sha}  {subject}")
    if subject != args.message.strip().splitlines()[0].strip():
        out(f"(message normalized from: {args.message.strip().splitlines()[0].strip()})")
    if complete:
        meta.update(status="complete", closed=now())
        tasks.write_meta(task, meta)
        tasks.event(task, "complete", head=sha)
        out("GOAL COMPLETE. The task is closed.",
            f"Task diff: git -C {root} diff {meta.get('base_commit')}..HEAD")
    else:
        out(f"NEXT: {state.get('next')}")
    out("Not pushed. This skill never pushes.")
    return EXIT_PASS


def cmd_accept_config(args):
    """Record config values the user changed mid-task. Only on the user's say-so."""
    root = git_root()
    task = tasks.resolve(root)
    meta = tasks.read_meta(task)
    if meta.get("config_hash") == config.config_hash():
        out("The config has not changed. Nothing to accept.")
        return EXIT_PASS
    changes = config.changes(meta.get("config", {}))
    meta.update(config_hash=config.config_hash(), config=dict(CFG))
    tasks.write_meta(task, meta)
    state = tasks.read_state(task)
    state.update(last_pass=None, last_pass_complete=False)
    tasks.write_state(task, state)
    tasks.event(task, "config-accept", changes=changes)
    out("ACCEPTED: the new config is recorded for this task.", *changes,
        "Any earlier pass is void. Run check.py before committing.")
    return EXIT_PASS


def cmd_close(args):
    root = git_root()
    task = tasks.resolve(root)
    meta = tasks.read_meta(task)
    meta.update(status="closed", closed=now())
    tasks.write_meta(task, meta)
    state = tasks.read_state(task)
    state.update(last_pass=None, last_pass_complete=False)
    tasks.write_state(task, state)
    tasks.event(task, "close", detail="closed incomplete")
    out(f"CLOSED  {meta['id']}", "Uncommitted changes, if any, were left as they are.")
    return EXIT_PASS


def cmd_hook(args):
    """pre-commit: while a task is active, only --commit may commit, and only the gated tree."""
    root = git_root()
    matches = tasks.find(root, ("active",))
    if not matches:
        return EXIT_PASS
    state = tasks.read_state(matches[0]) if len(matches) == 1 else {}
    rc, staged = git(root, "write-tree")
    staged = staged.strip()
    if rc == 0 and staged and staged == state.get("last_pass") == os.environ.get(COMMIT_ENV):
        return EXIT_PASS
    out("task-contract: commit rejected. It did not pass the gate.",
        f"Active task: {', '.join(m.name for m in matches)}",
        "Run check.py, then check.py --commit. To stop the task: check.py --close.")
    return EXIT_BLOCK


def main():
    parser = argparse.ArgumentParser(add_help=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--start", action="store_true")
    modes.add_argument("--commit", action="store_true")
    modes.add_argument("--accept-config", action="store_true")
    modes.add_argument("--close", action="store_true")
    modes.add_argument("--hook", action="store_true")
    parser.add_argument("-m", "--message", default="")
    parser.add_argument("--session", default="")
    args = parser.parse_args()
    jev.SESSION = args.session
    if args.hook:
        return cmd_hook(args)
    config.load()
    if args.start:
        return cmd_start(args)
    if args.commit:
        if not args.message.strip():
            die(EXIT_PRECONDITION, "PRECONDITION FAILED: --commit requires -m <message>.")
        return cmd_commit(args)
    if args.accept_config:
        return cmd_accept_config(args)
    if args.close:
        return cmd_close(args)
    return cmd_gate(args)


if __name__ == "__main__":
    run(main)
