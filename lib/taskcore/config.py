"""config.json: every tunable, validated. Invalid config never falls back."""

import json

from . import common
from .common import EXIT_PRECONDITION, die, text_hash

# Each config path, its type and allowed range.
SCHEMA = {
    ("model",): (str, None, None),
    ("goal_clarity", "min_precision_score"): (float, 0, 3),
    ("goal_clarity", "min_boundedness_score"): (float, 0, 3),
    ("goal_clarity", "min_confidence"): (float, 0, 1),
    ("goal_clarity", "drift_license_block"): (float, 0, 1),
    ("objective_clarity", "multiple_conditions_block"): (float, 0, 1),
    ("objective_clarity", "not_checkable_block"): (float, 0, 1),
    ("objective_clarity", "vague_block"): (float, 0, 1),
    ("objective_clarity", "rule_is_objective_block"): (float, 0, 1),
    ("scope", "block_verdict_confidence"): (float, 0, 1),
    ("scope", "drift_block"): (float, 0, 1),
    ("scope", "min_verdict_confidence"): (float, 0, 1),
    ("completion", "item_complete"): (float, 0, 1),
    ("diff", "scope_context_lines"): (int, 0, 50),
    ("diff", "completion_fallback_lines"): (int, 0, 50),
    ("verify", "timeout_seconds"): (int, 1, 7200),
    ("verify", "requires_timeout_seconds"): (int, 1, 600),
    ("request_budget", "max_tokens"): (int, 1000, 32000),
    ("request_budget", "headroom"): (float, 0.1, 1),
    ("request_budget", "chars_per_token"): (float, 1, 6),
    ("commits", "max_subject_chars"): (int, 20, 200),
    ("handoff", "context_percent"): (int, 10, 95),
}

CFG = {}        # flat {"scope.drift_block": 0.6, ...} once loaded


def load():
    try:
        raw = json.loads(common.CONFIG_FILE.read_text())
    except OSError:
        die(EXIT_PRECONDITION, f"PRECONDITION FAILED: cannot read {common.CONFIG_FILE}.")
    except ValueError as err:
        die(EXIT_PRECONDITION, f"PRECONDITION FAILED: {common.CONFIG_FILE} is not valid JSON ({err}).")
    load_dict(raw)


def load_dict(raw):
    problems = []

    def unknown(node, prefix):
        for key, value in node.items():
            if key.startswith("_"):
                continue
            path = prefix + (key,)
            if isinstance(value, dict):
                unknown(value, path)
            elif path not in SCHEMA:
                problems.append(f"unknown setting {'.'.join(path)}")

    if not isinstance(raw, dict):
        raw = {}
        problems.append("the top level must be an object")
    unknown(raw, ())

    flat = {}
    for path, (kind, low, high) in SCHEMA.items():
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

    if problems:
        die(EXIT_PRECONDITION,
            "PRECONDITION FAILED: config.json is invalid. Nothing was checked.",
            *[f"  - {p}" for p in problems],
            f"Config: {common.CONFIG_FILE}")
    CFG.clear()
    CFG.update(flat)


def config_hash():
    """Hash of the effective values only, so editing a note is not a change."""
    return text_hash(json.dumps(CFG, sort_keys=True))


def changes(old):
    return [f"  {key}: {old.get(key, '(unset)')} -> {value}"
            for key, value in CFG.items() if old.get(key) != value]


def handoff_line():
    return (f"Handoff: at about {CFG['handoff.context_percent']}% context use, "
            "only when reliable usage information is available.")
