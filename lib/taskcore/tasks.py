"""The task folder under history/. Plain code: which task, which goal, what state.

    goal.md          current goal, read-only
    goal.v<N>.md     every approved version, read-only
    goal.json        current goal parsed, for the viewer
    meta.json        identity, status, goal and config fingerprints
    state.json       status of every objective and Verify command, and the last passing tree
    events.jsonl     every event, one JSON object per line
    jev.jsonl        every Jev question and answer
    verify/*.log     output of Verify commands that failed or couldn't run
"""

import json
import re

from . import common, config, goalfmt, jev
from .common import EXIT_PRECONDITION, die, now, text_hash

ACTIVE = ("ready", "active")      # a repository has at most one task in these states


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:40].strip("-")


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


def read_meta(task):
    return read_json(task / "meta.json")


def write_meta(task, meta):
    write_json(task / "meta.json", meta)


def read_state(task):
    return read_json(task / "state.json", {})


def write_state(task, state):
    write_json(task / "state.json", state)


def event(task, name, **detail):
    record = {"at": now(), "event": name, **({"session": jev.SESSION} if jev.SESSION else {}), **detail}
    with (task / "events.jsonl").open("a") as handle:
        handle.write(json.dumps(record) + "\n")


def find(root, statuses=ACTIVE):
    if not common.TASKS_DIR.is_dir():
        return []
    matches = []
    for candidate in sorted(common.TASKS_DIR.iterdir()):
        if not candidate.is_dir() or candidate.name.startswith(("_", ".")):
            continue
        meta = read_meta(candidate)
        if meta and meta.get("repo") == str(root) and meta.get("status") in statuses:
            matches.append(candidate)
    return matches


def resolve(root, statuses=ACTIVE):
    """The one task for this repository in `statuses`. No agent input decides it."""
    matches = find(root, statuses)
    if not matches:
        wanted = " or ".join(statuses)
        die(EXIT_PRECONDITION,
            f"PRECONDITION FAILED: no {wanted} task for this repository.",
            f"Repository: {root}",
            "Record a goal first with task-goal (goal.py --record).")
    if len(matches) > 1:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: more than one open task for this repository.",
            "The user must close one before work continues.",
            *[f"  {m}" for m in matches])
    jev.set_task(matches[0])
    return matches[0]


def create(root, slug, today):
    base = f"{today}-{root.name}-{slug}"
    task = common.TASKS_DIR / base
    counter = 2
    while task.exists():
        task = common.TASKS_DIR / f"{base}-{counter}"
        counter += 1
    task.mkdir(parents=True)
    jev.set_task(task)
    return task


def write_readonly(path, text):
    if path.exists():
        path.chmod(0o644)
    path.write_text(text)
    path.chmod(0o444)


def write_goal(task, text, version, goal):
    """goal.md and each goal.v<N>.md are read-only, so a stray edit fails loudly."""
    write_readonly(task / f"goal.v{version}.md", text)
    write_readonly(task / "goal.md", text)
    write_json(task / "goal.json", {"version": version, **goal.to_dict()})


def load_goal(task, meta):
    """The current goal, provided nobody changed goal.md outside the scripts."""
    text = (task / "goal.md").read_text()
    if text_hash(text) != meta.get("goal_hash"):
        event(task, "goal-changed", detail="goal.md edited outside the scripts; work stopped")
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: goal.md changed outside the scripts.",
            "If the user edited it, they approve it as a new version with task-goal:",
            f"  goal.py --revise < '{task / 'goal.md'}'",
            "If they did not, the edit is not theirs: report it and change nothing.",
            f"Goal: {task / 'goal.md'}")
    goal, errors = goalfmt.parse(text)
    if errors:
        die(EXIT_PRECONDITION, "PRECONDITION FAILED: the recorded goal no longer parses.",
            *[f"  - {e}" for e in errors])
    return text, goal


def verified_config(task, meta):
    """Stop if the thresholds moved since this task last accepted them."""
    if meta.get("config_hash") == config.config_hash():
        return
    changes = config.changes(meta.get("config", {}))
    event(task, "config-changed", detail="config.json changed mid-task; work stopped", changes=changes)
    die(EXIT_PRECONDITION,
        "PRECONDITION FAILED: config.json changed since this task last ran.",
        *changes,
        "",
        "If the user made this change, they tell you to run check.py --accept-config.",
        "If they did not, the change is not theirs: report it and change nothing.",
        f"Config: {common.CONFIG_FILE}")


def fresh_state(goal, old=None):
    """State for a goal version. Entries whose ID survives keep their record;
    goal.py clears the ones whose text changed before calling this."""
    old = old or {}
    objectives = old.get("objectives", {})
    verify = old.get("verify", {})
    return {
        "objectives": {o.id: objectives.get(o.id, pending("no changes in its files yet"))
                       for o in goal.objectives},
        "verify": {c.id: verify.get(c.id, pending("waits for every objective to be met"))
                   for c in goal.verify},
        "last_pass": None,
        "last_pass_complete": False,
        "next": None,
    }


def pending(reason):
    return {"state": "pending", "reason": reason}


HOOK_MARK = "# task-contract pre-commit hook"


def install_hook(root, check_path):
    """Reject commits the gate did not pass while a task is active.

    Never replaces a hook it did not write. Inert when no task is active.
    """
    from .gitutil import git, git_path
    _, hooks_path = git(root, "config", "core.hooksPath")
    if hooks_path.strip():
        return "WARNING: core.hooksPath is set; no hook installed. Direct commits are not blocked."
    hook = git_path(root, "hooks/pre-commit")
    if hook.exists() and HOOK_MARK not in hook.read_text(errors="replace"):
        return f"WARNING: {hook} exists and was left alone. Direct commits are not blocked."
    hook.parent.mkdir(parents=True, exist_ok=True)
    hook.write_text(
        "#!/bin/sh\n"
        f"{HOOK_MARK}\n"
        "# Rejects commits the task-contract gate did not pass while a task is active.\n"
        f'CHECK="{check_path}"\n'
        '[ -f "$CHECK" ] || exit 0\n'
        'exec python3 "$CHECK" --hook\n'
    )
    hook.chmod(0o755)
    return f"Hook:    {hook}"
