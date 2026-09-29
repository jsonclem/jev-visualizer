"""Jev's checks on the wording of a goal. Structure is goalfmt's job; this is judgment.

One request for the whole goal, then one small request per objective and per
rule, so a failure names the item and a long goal never overflows a request.
"""

from . import jev
from .common import text_hash
from .config import CFG


def goal_questions():
    """Two axes. `precision` is whether done is determinable. `boundedness` is
    whether the wording confines the work. A goal can be precise and still
    license drift, and the scope gate cannot catch that: if the goal permits
    extra work, extra work is in scope. Whether there is a deliverable, a done
    condition, or several tasks is now structure: Objectives and Verify."""
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
        "open_ended": {
            "type": "noul",
            "instructions": (
                "Does `goal` rely on an open-ended verb such as improve, clean up, "
                "optimize, or refactor without naming a specific target?"
            ),
        },
    }


def objective_questions():
    """Each asks about a defect, so a high value is bad."""
    return {
        "multiple_conditions": {
            "type": "noul",
            "instructions": (
                "Does `objective` state more than one independent condition, where one "
                "could be met while another is missed?"
            ),
        },
        "not_checkable": {
            "type": "noul",
            "instructions": (
                "Would judging whether `objective` is met need more than reading the "
                "changes to the files on its Files line, such as running the app, a "
                "person's judgment, or files it does not list?"
            ),
        },
        "vague": {
            "type": "noul",
            "instructions": (
                "Does `objective` rely on a subjective qualifier such as better, properly, "
                "robust, clean, or appropriate, whose meaning the reader must decide?"
            ),
        },
    }


def rule_questions():
    return {
        "is_objective": {
            "type": "noul",
            "instructions": (
                "Does `rule` ask for a change to be made, rather than limit how changes "
                "are made or what must stay the same?"
            ),
        },
    }


GOAL_HINTS = {
    "drift_license": "remove the permission to do unspecified work",
    "vague_qualifier": "replace the subjective qualifier with a concrete condition",
    "requires_inference": "state what is currently left for the reader to decide",
    "unbounded_target": "name the specific files or components",
    "open_ended": "name the specific change instead of an open-ended verb",
}
HINT_FLOOR = {"requires_inference": 0.85}

OBJECTIVE_CHECKS = {
    "multiple_conditions": ("objective_clarity.multiple_conditions_block",
                            "more than one condition: split it into separate objectives"),
    "not_checkable": ("objective_clarity.not_checkable_block",
                      "can't be judged from its files: name the files, or move it to Verify"),
    "vague": ("objective_clarity.vague_block",
              "subjective wording: replace it with a concrete condition"),
}


def check(goal_text, goal):
    """(ok, report lines, results for the event log)."""
    context = {"goal_hash": text_hash(goal_text)}
    report, failures, results = [], [], {}

    questions = goal_questions()
    state = {"goal": goal_text}
    if not jev.fits(state, questions):
        return False, ["  - The goal is too long for one Jev request. Shorten it or split the task."], {}
    answers = jev.ask(state, questions, "clarity", context, cache=True)
    precision, boundedness = answers["precision"], answers["boundedness"]
    noul = {k: v["noul"] for k, v in answers.items() if v["type"] == "noul"}
    results["goal"] = {
        "precision": {"score": precision["score"], "confidence": precision["confidence"]},
        "boundedness": {"score": boundedness["score"], "confidence": boundedness["confidence"]},
        **noul,
    }
    report += [
        "  goal:",
        f"    precision          {precision['score']:.2f} of 3.00  (confidence {precision['confidence']:.2f})",
        f"    boundedness        {boundedness['score']:.2f} of 3.00  (confidence {boundedness['confidence']:.2f})",
        *[f"    {k:<18} {v:.2f}" for k, v in noul.items()],
    ]
    goal_failures = []
    if noul["drift_license"] >= CFG["goal_clarity.drift_license_block"]:
        goal_failures.append("The goal gives permission to do work it does not specify. "
                             "Every scope check downstream would treat that extra work as authorized.")
    if precision["score"] < CFG["goal_clarity.min_precision_score"]:
        goal_failures.append(f"Not precise enough to adjudicate against (precision "
                             f"{precision['score']:.2f}, needs {CFG['goal_clarity.min_precision_score']:.2f}).")
    if boundedness["score"] < CFG["goal_clarity.min_boundedness_score"]:
        goal_failures.append(f"The wording does not confine the work (boundedness "
                             f"{boundedness['score']:.2f}, needs {CFG['goal_clarity.min_boundedness_score']:.2f}).")
    if precision["confidence"] < CFG["goal_clarity.min_confidence"]:
        goal_failures.append("Jev is not confident enough reading how precise the goal is.")
    if boundedness["confidence"] < CFG["goal_clarity.min_confidence"]:
        goal_failures.append("Jev is not confident enough reading how bounded the goal is.")
    if goal_failures:
        failures += [f"goal: {f}" for f in goal_failures]
        failures += [f"goal, to fix: {hint}" for key, hint in GOAL_HINTS.items()
                     if noul.get(key, 0) >= HINT_FLOOR.get(key, 0.60)]

    results["objectives"] = {}
    for objective in goal.objectives:
        answers = jev.ask({"objective": objective.render()}, objective_questions(), "clarity-objective",
                          {**context, "id": objective.id}, cache=True)
        values = {k: answers[k]["noul"] for k in OBJECTIVE_CHECKS}
        results["objectives"][objective.id] = values
        bad = [(k, v) for k, v in values.items() if v >= CFG[OBJECTIVE_CHECKS[k][0]]]
        report.append(f"  {objective.id:<4} " + "  ".join(f"{k} {v:.2f}" for k, v in values.items())
                      + ("" if bad else "  ok"))
        failures += [f"{objective.id}: {OBJECTIVE_CHECKS[k][1]} ({v:.2f})" for k, v in bad]

    results["rules"] = {}
    for rule in goal.rules:
        answers = jev.ask({"rule": rule.text}, rule_questions(), "clarity-rule",
                          {**context, "id": rule.id}, cache=True)
        value = answers["is_objective"]["noul"]
        results["rules"][rule.id] = {"is_objective": value}
        bad = value >= CFG["objective_clarity.rule_is_objective_block"]
        report.append(f"  {rule.id:<4} is_objective {value:.2f}" + ("" if bad else "  ok"))
        if bad:
            failures.append(f"{rule.id}: asks for a change, so it is an objective: move it to Objectives ({value:.2f})")

    if failures:
        report += ["", "  Not ready:"] + [f"  - {f}" for f in failures]
    return not failures, report, results
