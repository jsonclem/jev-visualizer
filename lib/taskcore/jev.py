"""TypeSafe's Jev API: judgment only. Every exchange is recorded in the task's jev.jsonl."""

import json
import os
import time
import urllib.error
import urllib.request

from . import common
from .common import EXIT_ESCALATE, EXIT_PRECONDITION, die, now, text_hash
from .config import CFG, config_hash

API_URL = "https://api.typesafe.ai/v1/systemone"

# Every Jev exchange is appended to the task's jev.jsonl as soon as it returns.
# Before a task exists (the checks at --record) it waits in RECORDS.
CURRENT_TASK = None
SESSION = ""
RECORDS = []


def estimate_tokens(value):
    text = value if isinstance(value, str) else json.dumps(value)
    return int(len(text) // CFG["request_budget.chars_per_token"]) + 1


def budget():
    return CFG["request_budget.max_tokens"] * CFG["request_budget.headroom"]


def request_tokens(state, questions):
    return estimate_tokens(state) + max(estimate_tokens(q) for q in questions.values())


def fits(state, questions):
    return request_tokens(state, questions) <= budget()


def api_key():
    key = os.environ.get("JEV_API_KEY") or os.environ.get("TYPESAFE_API_KEY")
    if key:
        return key.strip()
    if common.ENV_FILE.is_file():
        for raw in common.ENV_FILE.read_text(errors="replace").splitlines():
            raw = raw.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            name, _, value = raw.partition("=")
            if name.strip() in ("JEV_API_KEY", "TYPESAFE_API_KEY") and value.strip():
                return value.strip().strip("'\"")
    die(EXIT_PRECONDITION,
        "PRECONDITION FAILED: no API key.",
        f"Set JEV_API_KEY in {common.ENV_FILE} or in the environment.")


def set_task(task):
    global CURRENT_TASK
    CURRENT_TASK = task
    flush()


def flush():
    if CURRENT_TASK is None or not RECORDS:
        return
    with (CURRENT_TASK / "jev.jsonl").open("a") as handle:
        for record in RECORDS:
            handle.write(json.dumps(record) + "\n")
    RECORDS.clear()


def record(check, context, questions, answers, model, cached=False):
    RECORDS.append({
        "time": now(),
        "check": check,
        "model": model,
        "config_hash": config_hash(),
        "session": SESSION or None,
        "cached": cached,
        "context": context,
        "questions": questions,
        "answers": answers,
    })
    flush()


def cache_file(state, questions):
    key = text_hash(json.dumps([CFG["model"], state, questions], sort_keys=True))[7:]
    return common.TASKS_DIR / "_cache" / f"{key}.json"


def ask(state, questions, check, context, cache=False):
    """One Jev request. `check` names which check asked; `context` records what
    the state was built from. With `cache`, an identical earlier request is reused:
    goal checks repeat across --check, --record and --revise."""
    if cache:
        cached = cache_file(state, questions)
        if cached.is_file():
            answers = json.loads(cached.read_text())
            record(check, context, questions, answers, CFG["model"], cached=True)
            return answers
    answers, model = post(state, questions)
    record(check, context, questions, answers, model)
    if cache:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(answers))
    return answers


def post(state, questions):
    payload = json.dumps({"state": state, "model": CFG["model"], "questions": questions}).encode()
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
            return answers, data.get("model", CFG["model"])
        except urllib.error.HTTPError as err:
            body = err.read().decode(errors="replace")[:400]
            if err.code == 401:
                die(EXIT_PRECONDITION, "PRECONDITION FAILED: Jev rejected the API key (401).")
            if err.code in (429, 529) and attempt < 2:
                time.sleep(float(err.headers.get("retry-after") or delay))
                delay *= 2
                continue
            die(EXIT_ESCALATE, f"ESCALATE: Jev returned HTTP {err.code}. Nothing was checked.", body)
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt < 2:
                time.sleep(delay)
                delay *= 2
                continue
            die(EXIT_ESCALATE, f"ESCALATE: could not reach Jev ({err}). Nothing was checked.")
