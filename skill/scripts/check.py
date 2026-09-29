#!/usr/bin/env python3
"""Task Contract gate.

Jev decides judgments. This script decides facts. Tunables live in config.json.

Modes:
  --init --slug <slug>    Create a task (goal text on stdin, verbatim), or resume
                          the active one (nothing on stdin).
  (no arguments)          Gate the uncommitted change against the recorded goal.
  --commit -m <message>   Commit the gated change locally. Never pushes.
  --amend                 Append the user's correction (stdin, verbatim) to the goal.
  --accept-goal           Accept a goal.txt the user edited by hand.
  --accept-config         Accept config.json values the user changed mid-task.
  --close                 Close the active task without completing it.
  --hook                  pre-commit hook entry point. Not for direct use.

Exit codes:
  0  pass
  1  blocked, out of scope; the user decides whether to revert
  2  escalate to the user
  3  precondition failed
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# --- Tunables -----------------------------------------------------------------
# Every tunable lives in config.json next to SKILL.md. Each entry here maps a
# config path to the global it sets and its allowed range. A missing, unknown
# or out-of-range value stops the script rather than falling back silently.

CONFIG_SCHEMA = {
    ("model",): ("MODEL", str, None, None),
    ("goal_clarity", "min_precision_score"): ("MIN_PRECISION_SCORE", float, 0, 3),
    ("goal_clarity", "min_boundedness_score"): ("MIN_BOUNDEDNESS_SCORE", float, 0, 3),
    ("goal_clarity", "min_confidence"): ("MIN_GOAL_CONFIDENCE", float, 0, 1),
    ("goal_clarity", "drift_license_block"): ("DRIFT_LICENSE_BLOCK", float, 0, 1),
    ("scope", "block_verdict_confidence"): ("BLOCK_VERDICT_CONFIDENCE", float, 0, 1),
    ("scope", "drift_block"): ("DRIFT_NOUL_BLOCK", float, 0, 1),
    ("scope", "min_verdict_confidence"): ("MIN_VERDICT_CONFIDENCE", float, 0, 1),
    ("completion", "item_complete"): ("COMPLETE_NOUL", float, 0, 1),
    ("request_budget", "max_tokens"): ("MAX_REQUEST_TOKENS", int, 1000, 32000),
    ("request_budget", "headroom"): ("TOKEN_HEADROOM", float, 0.1, 1),
    ("request_budget", "chars_per_token"): ("CHARS_PER_TOKEN", float, 1, 6),
    ("commits", "max_subject_chars"): ("MAX_SUBJECT_CHARS", int, 20, 200),
    ("handoff", "context_percent"): ("HANDOFF_CONTEXT_PERCENT", int, 10, 95),
}

CHECK_PATH = Path(__file__).resolve()
CONFIG_FILE = CHECK_PATH.parent.parent / "config.json"
CONFIG = {}                        # flat {"scope.drift_block": 0.6, ...} once loaded

TASKS_DIR = CHECK_PATH.parent.parent.parent / "history"
API_URL = "https://api.typesafe.ai/v1/systemone"
ENV_FILE = TASKS_DIR / ".env"      # outside the skill folder, so sharing the skill never shares the key

EXIT_PASS, EXIT_BLOCK, EXIT_ESCALATE, EXIT_PRECONDITION = 0, 1, 2, 3

# Every Jev exchange is appended to the task's jev.jsonl as soon as it returns.
# Before a task exists (the clarity check at --init) it waits in JEV_RECORDS.
CURRENT_TASK = None
SESSION = ""
JEV_RECORDS = []
REVERT = 'git stash push -u -m "task-contract: blocked change"'
HOOK_MARK = "# task-contract pre-commit hook"
COMMIT_ENV = "TASK_CONTRACT_COMMIT"    # set by --commit to the gated tree; the hook requires it
CORRECTION = re.compile(r"^\[correction [^\]]*\]\s*$", re.MULTILINE)
ITEM = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+(.*\S)")


# --- Output -------------------------------------------------------------------

def out(*lines):
    for line in lines:
        print(line)


def die(code, *lines):
    out(*lines)
    sys.exit(code)


def now():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read_stdin():
    if sys.stdin is None or sys.stdin.isatty():
        return ""
    return sys.stdin.read().strip()


# --- Config -------------------------------------------------------------------

def load_config():
    """Read config.json into the tunable globals. Invalid config never falls back."""
    try:
        raw = json.loads(CONFIG_FILE.read_text())
    except OSError:
        die(EXIT_PRECONDITION, f"PRECONDITION FAILED: cannot read {CONFIG_FILE}.")
    except ValueError as err:
        die(EXIT_PRECONDITION, f"PRECONDITION FAILED: {CONFIG_FILE} is not valid JSON ({err}).")

    problems = []

    def unknown(node, prefix):
        for key, value in node.items():
            if key.startswith("_"):
                continue
            path = prefix + (key,)
            if isinstance(value, dict):
                unknown(value, path)
            elif path not in CONFIG_SCHEMA:
                problems.append(f"unknown setting {'.'.join(path)}")

    if not isinstance(raw, dict):
        raw = {}
        problems.append("the top level must be an object")
    unknown(raw, ())

    flat = {}
    for path, (name, kind, low, high) in CONFIG_SCHEMA.items():
        label = ".".join(path)
        node = raw
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None
        numeric = isinstance(node, (int, float)) and not isinstance(node, bool)
        if kind is str and not (isinstance(node, str) and node.strip()):
            problems.append(f"{label} is missing or empty")
            continue
        if kind is not str and not numeric:
            problems.append(f"{label} is missing or not a number")
            continue
        if kind is int and not float(node).is_integer():
            problems.append(f"{label} must be a whole number")
            continue
        value = kind(node)
        if low is not None and not low <= value <= high:
            problems.append(f"{label} = {value} is outside {low} to {high}")
            continue
        flat[label] = value
        globals()[name] = value

    if problems:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: config.json is invalid. Nothing was checked.",
            *[f"  - {p}" for p in problems],
            f"Config: {CONFIG_FILE}")
    CONFIG.update(flat)


def config_hash():
    """Hash of the effective values only, so editing a note is not a change."""
    return text_hash(json.dumps(CONFIG, sort_keys=True))


def config_changes(old):
    return [f"  {key}: {old.get(key, '(unset)')} -> {value}"
            for key, value in CONFIG.items() if old.get(key) != value]


def verified_config(task, meta):
    """Stop if the thresholds moved since this task last accepted them."""
    if meta.get("config_hash") == config_hash():
        return
    changes = config_changes(meta.get("config", {}))
    log(task, "config-changed", "config.json changed mid-task; work stopped", changes)
    die(EXIT_PRECONDITION,
        "PRECONDITION FAILED: config.json changed since this task last ran.",
        *changes,
        "",
        "If the user made this change, they tell you to run check.py --accept-config.",
        "If they did not, the change is not theirs: report it and change nothing.",
        f"Config: {CONFIG_FILE}")


def handoff_line():
    return (f"Handoff: at about {HANDOFF_CONTEXT_PERCENT}% context use, "
            "only when reliable usage information is available.")


# --- Environment --------------------------------------------------------------

def api_key():
    key = os.environ.get("JEV_API_KEY") or os.environ.get("TYPESAFE_API_KEY")
    if key:
        return key.strip()
    if ENV_FILE.is_file():
        for raw in ENV_FILE.read_text(errors="replace").splitlines():
            raw = raw.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            name, _, value = raw.partition("=")
            if name.strip() in ("JEV_API_KEY", "TYPESAFE_API_KEY") and value.strip():
                return value.strip().strip("'\"")
    die(EXIT_PRECONDITION,
        "PRECONDITION FAILED: no API key.",
        f"Set JEV_API_KEY in {ENV_FILE} or in the environment.")


# --- Git ----------------------------------------------------------------------

def git(root, *args, check=False, env=None):
    proc = subprocess.run(
        ["git"] + (["-C", str(root)] if root else []) + list(args),
        capture_output=True, text=True, env=env,
    )
    if check and proc.returncode != 0:
        die(EXIT_ESCALATE,
            f"ESCALATE: git {' '.join(args)} failed.",
            proc.stderr.strip())
    return proc.returncode, proc.stdout


def git_path(root, name):
    _, path = git(root, "rev-parse", "--git-path", name, check=True)
    path = Path(path.strip())
    return path if path.is_absolute() else root / path


def git_root():
    rc, root = git(None, "rev-parse", "--show-toplevel")
    if rc != 0 or not root.strip():
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: not inside a git repository.",
            "This skill requires git. The diff gate and the revert both depend on it.")
    return Path(root.strip())


def require_clean(root):
    _, status = git(root, "status", "--porcelain")
    if status.strip():
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: working tree is not clean.",
            "Commit or stash your own changes first. Nothing was modified.",
            "",
            status.rstrip())


def head_sha(root):
    rc, sha = git(root, "rev-parse", "--short", "HEAD")
    if rc != 0:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: repository has no commits.",
            "Make an initial commit first.")
    return sha.strip()


def head_tree(root):
    _, tree = git(root, "rev-parse", "HEAD^{tree}", check=True)
    return tree.strip()


def snapshot(root):
    """Tree id of the working directory as it stands, untracked files included.

    Built in a throwaway index so the user's staging area is never touched. The
    gate, the commit and the pre-commit hook all compare this one fingerprint.
    """
    real_index = git_path(root, "index")
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp) / "index"
        if real_index.is_file():
            shutil.copyfile(real_index, scratch)
        env = {**os.environ, "GIT_INDEX_FILE": str(scratch)}
        git(root, "add", "-A", check=True, env=env)
        _, tree = git(root, "write-tree", check=True, env=env)
    return tree.strip()


def changed_lines(root, since, tree):
    """Only the changed lines. Jev loses accuracy on context it does not need."""
    rc, diff = git(root, "diff", "-U0", "--no-color", "--no-ext-diff", since, tree)
    return diff if rc == 0 else None


def split_files(diff):
    """[(path, text)] per file in a unified diff."""
    files = []
    for block in re.split(r"(?m)^(?=diff --git )", diff):
        if not block.strip():
            continue
        header = block.splitlines()[0]
        match = re.match(r"diff --git a/.* b/(.*)$", header)
        files.append((match.group(1) if match else header, block))
    return files


def repo_uses_conventional_commits(root):
    _, log = git(root, "log", "-20", "--pretty=%s")
    subjects = [s for s in log.splitlines() if s.strip()]
    if len(subjects) < 5:
        return False
    pattern = re.compile(r"^\w+(\([^)]*\))?!?: ")
    hits = sum(1 for s in subjects if pattern.match(s))
    return hits >= max(2, len(subjects) * 0.3)


# --- Jev ----------------------------------------------------------------------

def estimate_tokens(value):
    text = value if isinstance(value, str) else json.dumps(value)
    return len(text) // CHARS_PER_TOKEN + 1


def fits(state, questions):
    longest = max(estimate_tokens(q) for q in questions.values())
    return estimate_tokens(state) + longest <= MAX_REQUEST_TOKENS * TOKEN_HEADROOM


def flush_jev_records():
    if CURRENT_TASK is None or not JEV_RECORDS:
        return
    with (CURRENT_TASK / "jev.jsonl").open("a") as handle:
        for record in JEV_RECORDS:
            handle.write(json.dumps(record) + "\n")
    JEV_RECORDS.clear()


def set_task(task):
    global CURRENT_TASK
    CURRENT_TASK = task
    flush_jev_records()


def jev(state, questions, check, context):
    """One Jev request. `check` names which check asked; `context` records what
    the state was built from (never the diff itself; git can rebuild it)."""
    payload = json.dumps({"state": state, "model": MODEL, "questions": questions}).encode()
    request = urllib.request.Request(
        API_URL, data=payload, method="POST",
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"},
    )
    delay = 1.0
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = json.loads(response.read())
            answers = data.get("answers") if isinstance(data, dict) else None
            if not isinstance(answers, dict) or set(questions) - set(answers):
                die(EXIT_ESCALATE,
                    "ESCALATE: Jev returned an unexpected response. Nothing was checked.",
                    json.dumps(data)[:400])
            JEV_RECORDS.append({
                "time": now(),
                "check": check,
                "model": data.get("model", MODEL),
                "config_hash": config_hash(),
                "session": SESSION or None,
                "context": context,
                "questions": questions,
                "answers": answers,
            })
            flush_jev_records()
            return answers
        except urllib.error.HTTPError as err:
            body = err.read().decode(errors="replace")[:400]
            if err.code == 401:
                die(EXIT_PRECONDITION,
                    "PRECONDITION FAILED: Jev rejected the API key (401).")
            if err.code in (429, 529) and attempt < 2:
                time.sleep(float(err.headers.get("retry-after") or delay))
                delay *= 2
                continue
            die(EXIT_ESCALATE,
                f"ESCALATE: Jev returned HTTP {err.code}. Nothing was checked.",
                body)
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt < 2:
                time.sleep(delay)
                delay *= 2
                continue
            die(EXIT_ESCALATE, f"ESCALATE: could not reach Jev ({err}). Nothing was checked.")


def goal_questions():
    """Two axes. `precision` is whether done is determinable. `boundedness` is
    whether the wording confines the work. A goal can be precise and still
    license drift, and the scope gate cannot catch that: if the goal permits
    extra work, extra work is in scope."""
    return {
        "precision": {
            "type": "score",
            "instructions": "How precisely does `goal` define what counts as completing it?",
            "criteria": [
                "States an intention with no concrete deliverable; what counts as done is unstated",
                "Names a general area of work; the specific changes are left to the reader",
                "Names a concrete outcome, but some boundaries are unstated",
                "Names a concrete outcome and its boundaries; done is determinable from the text",
            ],
        },
        "boundedness": {
            "type": "score",
            "instructions": "How tightly does `goal` confine the work to what it states?",
            "criteria": [
                "Invites or permits work beyond what it states",
                "States a target but leaves the extent of the work to the reader's judgment",
                "Mostly bounded; a small amount is left to the reader",
                "Confines the work to exactly what it states; nothing is left to add",
            ],
        },
        "drift_license": {
            "type": "noul",
            "instructions": "Does `goal` give permission to do work it does not specify?",
            "criteria": {
                "true": {
                    "what": "Grants latitude to add, tidy, or decide beyond the stated result",
                    "examples": [
                        "feel free to clean up anything else",
                        "use your judgment on the rest",
                        "and whatever else makes sense",
                        "while you are in there, improve what you see",
                    ],
                },
                "false": {
                    "what": "Grants no latitude beyond the stated result",
                    "examples": ["Cap the retry loop in charge() at three attempts"],
                },
            },
        },
        "vague_qualifier": {
            "type": "noul",
            "instructions": (
                "Does `goal` rely on a subjective qualifier such as better, properly, "
                "robust, clean, or appropriate, whose meaning the reader must decide?"
            ),
        },
        "requires_inference": {
            "type": "noul",
            "instructions": (
                "Would a competent engineer have to decide something `goal` leaves "
                "unstated that would change which files or which behavior are affected?"
            ),
        },
        "unbounded_target": {
            "type": "noul",
            "instructions": (
                "Does `goal` name an unbounded target such as all files, everywhere, "
                "or the whole codebase, rather than specific ones?"
            ),
        },
        "has_deliverable": {
            "type": "noul",
            "instructions": "Does `goal` name a concrete deliverable or outcome?",
        },
        "has_done_condition": {
            "type": "noul",
            "instructions": "Does `goal` state an observable condition for being complete?",
        },
        "multiple_tasks": {
            "type": "noul",
            "instructions": "Does `goal` contain more than one independent task?",
        },
        "open_ended": {
            "type": "noul",
            "instructions": (
                "Does `goal` rely on an open-ended verb such as improve, clean up, "
                "optimize, or refactor without naming a specific target?"
            ),
        },
    }


def gate_questions():
    """Asked once per file, or per group of hunks when a file is large."""
    return {
        "verdict": {
            "type": "choice",
            "instructions": "Does `diff` make only changes that `goal` asks for?",
            "criteria": {
                "within_scope": {
                    "what": "Every change in `diff` is required by `goal`",
                    "not_for": "Changes that are merely adjacent, tidy, or beneficial",
                },
                "outside_scope": {
                    "what": "`diff` contains at least one change `goal` does not ask for",
                    "examples": [
                        "Renaming an unrelated symbol",
                        "Adding a dependency not requested",
                    ],
                },
            },
        },
        "drift_refactor": {
            "type": "noul",
            "instructions": (
                "Does `diff` contain cleanup, refactoring, renaming, or restructuring "
                "that `goal` does not ask for?"
            ),
        },
        "drift_deps": {
            "type": "noul",
            "instructions": "Does `diff` add a dependency that `goal` does not ask for?",
        },
        "drift_tests_docs": {
            "type": "noul",
            "instructions": (
                "Does `diff` add tests, documentation, or comments that `goal` does not ask for?"
            ),
        },
        "drift_behavior": {
            "type": "noul",
            "instructions": "Does `diff` change behavior beyond what `goal` asks for?",
        },
        "drift_substitute": {
            "type": "noul",
            "instructions": (
                "Does `diff` substitute a related improvement for the result `goal` asks for?"
            ),
        },
    }


def completion_questions(items):
    """One atomic question per goal item. Jev does not reliably weigh several
    items in one question, and it cannot count."""
    return {
        f"item_{n}": {
            "type": "noul",
            "instructions": f"Does `diff` fully implement this part of `goal`: {item}",
        }
        for n, item in enumerate(items, 1)
    }


DRIFT_KEYS = (
    "drift_refactor", "drift_deps", "drift_tests_docs",
    "drift_behavior", "drift_substitute",
)


def goal_items(goal_text):
    """The goal's separate items, decided by its layout, not by judgment.

    Each section (the original goal and each correction) contributes its
    bulleted or numbered lines, or the whole section if it has none.
    """
    items = []
    for section in CORRECTION.split(goal_text):
        section = section.strip()
        if not section:
            continue
        bullets = [m.group(1) for line in section.splitlines() if (m := ITEM.match(line))]
        items.extend(bullets or [section])
    return items


def chunks(goal_text, path, file_diff, questions):
    """Split one file's diff into requests that fit. None if one hunk cannot."""
    state = {"goal": goal_text, "file": path, "diff": file_diff}
    if fits(state, questions):
        return [file_diff]
    parts = re.split(r"(?m)^(?=@@)", file_diff)
    header, hunks = parts[0], parts[1:]
    groups, current = [], header
    for hunk in hunks:
        candidate = current + hunk
        if fits({**state, "diff": candidate}, questions):
            current = candidate
            continue
        if current == header:
            return None
        groups.append(current)
        current = header + hunk
        if not fits({**state, "diff": current}, questions):
            return None
    groups.append(current)
    return groups


# --- Task folder --------------------------------------------------------------

def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:40].strip("-")


def text_hash(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def read_meta(path):
    try:
        return json.loads((path / "meta.json").read_text())
    except (OSError, ValueError):
        return None


def write_meta(task, meta):
    (task / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")


def write_goal(task, text):
    """goal.txt is read-only between writes, so a stray edit fails loudly."""
    goal = task / "goal.txt"
    if goal.exists():
        goal.chmod(0o644)
    goal.write_text(text)
    goal.chmod(0o444)


def find_task(root):
    """Resolve the active task for this repo by recorded repo path. No agent input."""
    if not TASKS_DIR.is_dir():
        return []
    matches = []
    for candidate in sorted(TASKS_DIR.iterdir()):
        if not candidate.is_dir() or candidate.name.startswith("_"):
            continue
        meta = read_meta(candidate)
        if meta and meta.get("repo") == str(root) and meta.get("status") == "active":
            matches.append(candidate)
    return matches


def resolve_task(root):
    matches = find_task(root)
    if not matches:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: no active task for this repository.",
            f"Repository: {root}",
            "Run check.py --init --slug <slug> with the user's instructions on stdin.")
    if len(matches) > 1:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: more than one active task for this repository.",
            "The user must close one before work continues.",
            *[f"  {m}" for m in matches])
    set_task(matches[0])
    return matches[0]


def verified_goal(task, meta):
    """The goal text, provided nobody changed it outside this script."""
    goal_text = (task / "goal.txt").read_text()
    if text_hash(goal_text) != meta.get("goal_hash"):
        log(task, "goal-changed", "goal.txt edited outside check.py; work stopped")
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: goal.txt changed outside check.py.",
            "If the user edited it, they tell you to run check.py --accept-goal.",
            "If they did not, the edit is not theirs: report it and change nothing.",
            f"Goal: {task / 'goal.txt'}")
    return goal_text


def log(task, event, detail, lines=()):
    """One timestamped event, then its evidence indented beneath it."""
    with (task / "history.txt").open("a") as handle:
        handle.write(f"{now()}  {event:<14} {detail}\n")
        for line in lines:
            handle.write(f"{'':<42}{line.rstrip()}\n")


def session_suffix(session):
    return f" session={session}" if session else ""


def install_hook(root):
    """Reject commits the gate did not pass while a task is active.

    Never replaces a hook it did not write. Inert when no task is active.
    """
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
        f'CHECK="{CHECK_PATH}"\n'
        '[ -f "$CHECK" ] || exit 0\n'
        'exec python3 "$CHECK" --hook\n'
    )
    hook.chmod(0o755)
    return f"Hook:    {hook}"


# --- Clarity gate -------------------------------------------------------------

def check_clarity(goal_text):
    """Judgment on the wording of the goal, so Jev's job. No repo access.

    Returns (ok, report_lines). Failures name the specific defect so the user
    knows which words to change.
    """
    questions = goal_questions()
    if not fits({"goal": goal_text}, questions):
        return False, ["  - The goal is too long for one Jev request. Shorten it or split the task."]
    answers = jev({"goal": goal_text}, questions, "clarity",
                  {"goal_hash": text_hash(goal_text)})
    precision = answers["precision"]
    boundedness = answers["boundedness"]
    noul = {k: v["noul"] for k, v in answers.items() if v["type"] == "noul"}

    report = [
        f"  precision          {precision['score']:.2f} of 3.00  "
        f"(confidence {precision['confidence']:.2f})",
        f"  boundedness        {boundedness['score']:.2f} of 3.00  "
        f"(confidence {boundedness['confidence']:.2f})",
        *[f"  {k:<18} {v:.2f}" for k, v in noul.items()],
    ]

    failures = []
    if noul["drift_license"] >= DRIFT_LICENSE_BLOCK:
        failures.append(
            "The goal gives permission to do work it does not specify. "
            "Every scope check downstream would treat that extra work as authorized."
        )
    if precision["score"] < MIN_PRECISION_SCORE:
        failures.append(
            f"Not precise enough to adjudicate against "
            f"(precision {precision['score']:.2f}, needs {MIN_PRECISION_SCORE:.2f})."
        )
    if boundedness["score"] < MIN_BOUNDEDNESS_SCORE:
        failures.append(
            f"The wording does not confine the work "
            f"(boundedness {boundedness['score']:.2f}, needs {MIN_BOUNDEDNESS_SCORE:.2f})."
        )
    if precision["confidence"] < MIN_GOAL_CONFIDENCE:
        failures.append("Jev is not confident enough reading how precise the goal is.")
    if boundedness["confidence"] < MIN_GOAL_CONFIDENCE:
        failures.append("Jev is not confident enough reading how bounded the goal is.")

    if not failures:
        return True, report

    hints = {
        "drift_license": "remove the permission to do unspecified work",
        "vague_qualifier": "replace the subjective qualifier with a concrete condition",
        "requires_inference": "state what is currently left for the reader to decide",
        "unbounded_target": "name the specific files or components",
        "multiple_tasks": "list each independent result as its own bullet",
        "open_ended": "name the specific change instead of an open-ended verb",
    }
    hint_floor = {"requires_inference": 0.85}
    flagged = [
        f"    {k}: {hints[k]}"
        for k in hints
        if noul.get(k, 0) >= hint_floor.get(k, 0.60)
    ]
    if noul["has_deliverable"] < 0.50:
        flagged.append("    has_deliverable: name the concrete outcome")
    if noul["has_done_condition"] < 0.50:
        flagged.append("    has_done_condition: state how to tell it is finished")

    detail = report + [""] + [f"  - {f}" for f in failures]
    if flagged:
        detail += ["", "  To fix:"] + flagged
    return False, detail


# --- Modes --------------------------------------------------------------------

def cmd_init(args):
    root = git_root()
    sha = head_sha(root)
    piped = read_stdin()

    existing = find_task(root)
    if existing:
        task = resolve_task(root)
        meta = read_meta(task)
        if piped and text_hash(piped) != meta.get("input_hash"):
            die(EXIT_PRECONDITION,
                f"PRECONDITION FAILED: task {meta['id']} is already active for this repository.",
                "The new instructions were not recorded. To resume it, run --init with nothing on stdin.",
                "To start a different task, the user must first close this one (check.py --close).",
                f"Goal: {task / 'goal.txt'}")
        if args.slug and meta.get("slug") and slugify(args.slug) != meta["slug"]:
            die(EXIT_PRECONDITION,
                f"PRECONDITION FAILED: the active task is '{meta['slug']}', not '{slugify(args.slug)}'.",
                f"Goal: {task / 'goal.txt'}")
        verified_goal(task, meta)
        verified_config(task, meta)
        rc, _ = git(root, "cat-file", "-e", f"{meta.get('base_commit', '')}^{{commit}}")
        base_note = "" if rc == 0 else "  (base commit no longer reachable)"
        pending = ""
        tree = snapshot(root)
        if tree != head_tree(root):
            pending = ("passed the gate, not yet committed" if tree == meta.get("last_pass")
                       else "not yet gated; run check.py before committing")
        log(task, "resume", f"head={sha}{base_note}{session_suffix(args.session)}",
            [f"uncommitted: {pending}"] if pending else [])
        out(f"RESUMED  {meta['id']}",
            f"Goal:    {task / 'goal.txt'}",
            f"Base:    {meta.get('base_commit')}{base_note}",
            f"History: {task / 'history.txt'}",
            handoff_line())
        if pending:
            out(f"Uncommitted changes: {pending}")
        return EXIT_PASS

    require_clean(root)
    if not piped:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: no goal on stdin.",
            "Pipe the user's instructions, verbatim, to stdin.")

    ok, report = check_clarity(piped)
    if not ok:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: the goal is not ready to execute. No task was created.",
            *report,
            "",
            "Ask the user to sharpen the goal. You may propose wording, but record it",
            "only after the user approves that exact text: unapproved wording is your",
            "scope, not theirs.")

    slug = slugify(args.slug) or slugify(piped)
    if not slug:
        die(EXIT_PRECONDITION, "PRECONDITION FAILED: --slug produced an empty name.")
    base = f"{datetime.now().strftime('%Y-%m-%d')}-{root.name}-{slug}"
    task = TASKS_DIR / base
    counter = 2
    while task.exists():
        task = TASKS_DIR / f"{base}-{counter}"
        counter += 1

    task.mkdir(parents=True)
    set_task(task)
    goal_text = piped + "\n"
    write_goal(task, goal_text)
    (task / "history.txt").write_text("")
    write_meta(task, {
        "id": task.name,
        "slug": slug,
        "repo": str(root),
        "base_commit": sha,
        "goal_hash": text_hash(goal_text),
        "input_hash": text_hash(piped),
        "config_hash": config_hash(),
        "config": CONFIG,
        "created": now(),
        "status": "active",
    })
    hook_note = install_hook(root)
    log(task, "init", f"base={sha} config={config_hash()[7:19]}{session_suffix(args.session)}",
        ["clarity:"] + report)
    out(f"TASK CREATED  {task.name}",
        *report,
        "",
        f"Goal:    {task / 'goal.txt'}",
        f"Base:    {sha}",
        f"History: {task / 'history.txt'}",
        hook_note,
        handoff_line())
    return EXIT_PASS


def gate_step(root, task, goal_text, tree, suffix):
    """Scope-check the change since HEAD, one file (or hunk group) per request."""
    diff = changed_lines(root, "HEAD", tree)
    if diff is None:
        log(task, "gate", f"diff-failed tree={tree[:10]}{suffix}")
        die(EXIT_ESCALATE, "ESCALATE: could not diff the change against HEAD.")
    questions = gate_questions()
    results = []
    for path, file_diff in split_files(diff):
        parts = chunks(goal_text, path, file_diff, questions)
        if parts is None:
            log(task, "gate", f"too-large file={path} tree={tree[:10]}{suffix}")
            die(EXIT_ESCALATE,
                f"ESCALATE: a change in {path} is too large to check in one request.",
                "It was NOT checked and NOT truncated. Nothing was committed.")
        for n, part in enumerate(parts, 1):
            answers = jev({"goal": goal_text, "file": path, "diff": part}, questions, "scope",
                          {"file": path, "part": f"{n}/{len(parts)}",
                           "head": head_sha(root), "tree": tree})
            results.append((path, answers))
    return results


def gate_completion(root, goal_text, base, tree):
    """Per-item completion over the whole task since its base commit.

    Returns ({item: noul}, done) or (None, None) when it cannot be checked.
    """
    diff = changed_lines(root, base, tree)
    if diff is None:
        return None, None
    items = goal_items(goal_text)
    questions = completion_questions(items)
    state = {"goal": goal_text, "diff": diff}
    if not fits(state, questions):
        return None, None
    answers = jev(state, questions, "completion",
                  {"base": base, "tree": tree, "items": items})
    scores = {item: answers[f"item_{n}"]["noul"] for n, item in enumerate(items, 1)}
    return scores, all(v >= COMPLETE_NOUL for v in scores.values())


def cmd_gate(args):
    root = git_root()
    task = resolve_task(root)
    meta = read_meta(task)
    goal_text = verified_goal(task, meta)
    verified_config(task, meta)
    suffix = session_suffix(args.session)

    tree = snapshot(root)
    if tree == head_tree(root):
        log(task, "gate", f"no-changes{suffix}")
        die(EXIT_ESCALATE,
            "ESCALATE: there are no changes to check.",
            "Nothing was committed.",
            f"Goal: {task / 'goal.txt'}")

    results = gate_step(root, task, goal_text, tree, suffix)
    blocked, unsure = [], []
    drifts = {key: 0.0 for key in DRIFT_KEYS}
    per_file = []
    for path, answers in results:
        choice = answers["verdict"]["choice"]
        confidence = answers["verdict"]["confidence"]
        per_file.append(f"  {path}  {choice} ({confidence:.2f})")
        for key in DRIFT_KEYS:
            drifts[key] = max(drifts[key], answers[key]["noul"])
        if choice == "outside_scope" and confidence >= BLOCK_VERDICT_CONFIDENCE:
            blocked.append(path)
        elif confidence < MIN_VERDICT_CONFIDENCE:
            unsure.append(path)
    tripped = {k: v for k, v in drifts.items() if v >= DRIFT_NOUL_BLOCK}

    detail = per_file + [f"  {key:<16} {value:.2f}  (max)" for key, value in drifts.items()]
    goal_line = f"Goal: {task / 'goal.txt'}"
    ask_revert = [
        "Do not revert on your own. Show this to the user and ask.",
        f"If they approve, revert with: {REVERT}",
        "(Recoverable: git stash pop.)",
    ]

    if blocked or tripped:
        reason = []
        if blocked:
            reason.append("outside_scope=" + ",".join(sorted(set(blocked))))
        if tripped:
            reason.append("drift=" + ",".join(sorted(tripped)))
        log(task, "gate BLOCK", f"{' '.join(reason)} tree={tree[:10]}{suffix}",
            ["scope:"] + detail)
        die(EXIT_BLOCK,
            "BLOCKED: this change contains work the goal does not ask for.",
            *detail,
            "",
            *(["Tripped: " + ", ".join(f"{k} {v:.2f}" for k, v in sorted(tripped.items()))]
              if tripped else []),
            *ask_revert,
            goal_line)

    if unsure:
        log(task, "gate", f"low-confidence files={','.join(sorted(set(unsure)))}{suffix}",
            ["scope:"] + detail)
        die(EXIT_ESCALATE,
            "ESCALATE: Jev is not confident enough to gate this automatically.",
            *detail,
            "",
            "Nothing was committed. The user decides.",
            goal_line)

    scores, done = gate_completion(root, goal_text, meta.get("base_commit", ""), tree)
    meta["last_pass"] = tree
    meta["last_pass_complete"] = bool(done)
    write_meta(task, meta)

    if scores is None:
        status = "COMPLETION NOT CHECKED: the task's total change is too large for one request."
        completion = []
    else:
        status = "GOAL COMPLETE" if done else "GOAL NOT YET COMPLETE"
        completion = [f"  [{v:.2f}] {item[:70]}" for item, v in scores.items()]

    log(task, "gate PASS",
        f"complete={'unknown' if done is None else 'yes' if done else 'no'} "
        f"tree={tree[:10]} uncommitted=yes{suffix}",
        ["scope:"] + detail
        + (["completion:"] + completion if completion else ["completion: not checked (too large)"]))
    out("PASS: this change is within the recorded goal.",
        *detail,
        "",
        *(["Goal items:"] + completion if completion else []),
        status,
        'Commit it with: check.py --commit -m "<message>"')
    return EXIT_PASS


BAD_PREFIX = re.compile(
    r"^\s*(claude|codex|gpt|chatgpt|copilot|cursor|ai|bot|agent|assistant)\b[\s:>\-–—]+",
    re.IGNORECASE,
)
BAD_TRAILER = re.compile(
    r"^\s*(co-authored-by\s*:|generated with|created by (claude|codex|an? ai))",
    re.IGNORECASE,
)
CONVENTIONAL = re.compile(r"^\w+(\([^)]*\))?!?: ")
EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF️✅❌]"
)


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
    if len(subject) > MAX_SUBJECT_CHARS:
        subject = subject[:MAX_SUBJECT_CHARS].rsplit(" ", 1)[0].rstrip(",;:-")

    body = [line for line in kept[1:] if not EMOJI.search(line)]
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    return subject, body


def cmd_commit(args):
    root = git_root()
    task = resolve_task(root)
    meta = read_meta(task)
    verified_goal(task, meta)

    tree = snapshot(root)
    if tree == head_tree(root):
        die(EXIT_ESCALATE, "ESCALATE: there is nothing to commit.")
    if tree != meta.get("last_pass"):
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: no passing gate for the current changes.",
            "Run check.py with no arguments and act on its exit code.",
            "Nothing was committed.")

    subject, body = sanitize_message(args.message, repo_uses_conventional_commits(root))
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

    complete = meta.pop("last_pass_complete", False)
    meta.pop("last_pass", None)
    if complete:
        meta["status"] = "complete"
        meta["closed"] = now()
    write_meta(task, meta)

    sha = head_sha(root)
    log(task, "commit", f"{sha}  {subject}{session_suffix(args.session)}")
    out(f"COMMITTED  {sha}  {subject}")
    if subject != args.message.strip().splitlines()[0].strip():
        out(f"(message normalized from: {args.message.strip().splitlines()[0].strip()})")
    if complete:
        log(task, "complete", f"closed{session_suffix(args.session)}")
        out("GOAL COMPLETE. The task is closed.",
            f"Task diff: git -C {root} diff {meta.get('base_commit')}..HEAD")
    out("Not pushed. This skill never pushes.")
    return EXIT_PASS


def cmd_amend(args):
    """Append the user's own correction. The original text is never replaced."""
    root = git_root()
    task = resolve_task(root)
    meta = read_meta(task)
    goal_text = verified_goal(task, meta)
    verified_config(task, meta)
    correction = read_stdin()
    if not correction:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: no correction on stdin.",
            "Pipe the user's correction, verbatim, to stdin.")

    amended = f"{goal_text.rstrip()}\n\n[correction {now()}]\n{correction}\n"
    ok, report = check_clarity(amended)
    if not ok:
        log(task, "amend REJECT", f"correction not recorded{session_suffix(args.session)}",
            [f"correction: {correction}", "clarity:"] + report)
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: with this correction the goal is not ready to execute.",
            "goal.txt was not changed.",
            *report)
    write_goal(task, amended)
    meta["goal_hash"] = text_hash(amended)
    meta.pop("last_pass", None)
    meta.pop("last_pass_complete", None)
    write_meta(task, meta)
    log(task, "amend", f"correction appended{session_suffix(args.session)}",
        [f"correction: {correction}", "clarity:"] + report)
    out("AMENDED: the correction was appended to the goal.",
        *report,
        "",
        f"Goal: {task / 'goal.txt'}",
        "Any earlier pass is void. Run check.py before committing.")
    return EXIT_PASS


def cmd_accept_goal(args):
    """Record a goal.txt the user edited by hand. Only on the user's say-so."""
    root = git_root()
    task = resolve_task(root)
    meta = read_meta(task)
    verified_config(task, meta)
    goal_text = (task / "goal.txt").read_text()
    if text_hash(goal_text) == meta.get("goal_hash"):
        die(EXIT_PASS, "The goal has not changed. Nothing to accept.")
    ok, report = check_clarity(goal_text)
    if not ok:
        log(task, "accept REJECT", f"edited goal not accepted{session_suffix(args.session)}",
            ["clarity:"] + report)
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: the edited goal is not ready to execute.",
            *report)
    write_goal(task, goal_text)
    meta["goal_hash"] = text_hash(goal_text)
    meta.pop("last_pass", None)
    meta.pop("last_pass_complete", None)
    write_meta(task, meta)
    log(task, "goal-accept", f"user edit accepted{session_suffix(args.session)}",
        ["clarity:"] + report)
    out("ACCEPTED: the edited goal is recorded.", *report,
        "Any earlier pass is void. Run check.py before committing.")
    return EXIT_PASS


def cmd_accept_config(args):
    """Record config values the user changed mid-task. Only on the user's say-so."""
    root = git_root()
    task = resolve_task(root)
    meta = read_meta(task)
    if meta.get("config_hash") == config_hash():
        die(EXIT_PASS, "The config has not changed. Nothing to accept.")
    changes = config_changes(meta.get("config", {}))
    meta["config_hash"] = config_hash()
    meta["config"] = CONFIG
    meta.pop("last_pass", None)
    meta.pop("last_pass_complete", None)
    write_meta(task, meta)
    log(task, "config-accept", f"user config change accepted{session_suffix(args.session)}",
        changes)
    out("ACCEPTED: the new config is recorded for this task.", *changes,
        "Any earlier pass is void. Run check.py before committing.")
    return EXIT_PASS


def cmd_close(args):
    root = git_root()
    task = resolve_task(root)
    meta = read_meta(task)
    meta["status"] = "closed"
    meta["closed"] = now()
    meta.pop("last_pass", None)
    meta.pop("last_pass_complete", None)
    write_meta(task, meta)
    log(task, "close", f"closed incomplete{session_suffix(args.session)}")
    out(f"CLOSED  {meta['id']}",
        "Uncommitted changes, if any, were left as they are.")
    return EXIT_PASS


def cmd_hook(args):
    """pre-commit: while a task is active, only --commit may commit, and only the gated tree."""
    root = git_root()
    matches = find_task(root)
    if not matches:
        return EXIT_PASS
    meta = read_meta(matches[0]) if len(matches) == 1 else {}
    rc, staged = git(root, "write-tree")
    staged = staged.strip()
    if rc == 0 and staged and staged == meta.get("last_pass") == os.environ.get(COMMIT_ENV):
        return EXIT_PASS
    out("task-contract: commit rejected. It did not pass the gate.",
        f"Active task: {', '.join(m.name for m in matches)}",
        "Run check.py, then check.py --commit. To stop the task: check.py --close.")
    return EXIT_BLOCK


def main():
    parser = argparse.ArgumentParser(add_help=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--init", action="store_true")
    modes.add_argument("--commit", action="store_true")
    modes.add_argument("--amend", action="store_true")
    modes.add_argument("--accept-goal", action="store_true")
    modes.add_argument("--accept-config", action="store_true")
    modes.add_argument("--close", action="store_true")
    modes.add_argument("--hook", action="store_true")
    parser.add_argument("--slug", default="")
    parser.add_argument("-m", "--message", default="")
    parser.add_argument("--session", default="")
    args = parser.parse_args()
    global SESSION
    SESSION = args.session
    if not args.hook:
        load_config()

    if args.init:
        return cmd_init(args)
    if args.commit:
        if not args.message.strip():
            die(EXIT_PRECONDITION, "PRECONDITION FAILED: --commit requires -m <message>.")
        return cmd_commit(args)
    if args.amend:
        return cmd_amend(args)
    if args.accept_goal:
        return cmd_accept_goal(args)
    if args.accept_config:
        return cmd_accept_config(args)
    if args.close:
        return cmd_close(args)
    if args.hook:
        return cmd_hook(args)
    return cmd_gate(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as err:
        # A crash must never read as a verdict. Exit 1 would mean "blocked".
        out(f"ESCALATE: check.py failed unexpectedly ({type(err).__name__}: {err}).",
            "Nothing was checked, reverted, or committed.",
            "",
            traceback.format_exc().rstrip())
        sys.exit(EXIT_ESCALATE)
