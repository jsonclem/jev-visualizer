"""One gate: coverage (plain code), scope (Jev), completion per objective (Jev),
Verify (exit codes). Returns facts; routing.decide turns them into NEXT."""

import re

from . import goalfmt, jev, verify
from .common import EXIT_ESCALATE, die, now, text_hash
from .config import CFG
from .gitutil import changed_paths, diff, split_files

DRIFT_KEYS = ("drift_refactor", "drift_deps", "drift_tests_docs", "drift_behavior", "drift_substitute")


def scope_questions():
    """Asked once per changed file, or per group of hunks when a file is large."""
    return {
        "verdict": {
            "type": "choice",
            "instructions": (
                "Does `diff` make only changes that `objectives` ask for, while keeping "
                "to `rules` and leaving `out_of_scope` alone? `diff` is one step of the "
                "work: leaving part of `objectives` unfinished is not a scope problem."
            ),
            "criteria": {
                "within_scope": {
                    "what": "Every change in `diff` is required by `objectives`, even if some are not finished yet",
                    "not_for": "Changes that are merely adjacent, tidy, or beneficial",
                },
                "outside_scope": {
                    "what": "`diff` contains at least one change `objectives` do not ask for, "
                            "or breaks `rules`, or touches `out_of_scope`",
                    "examples": [
                        "Renaming an unrelated symbol",
                        "Adding a dependency not requested",
                    ],
                },
            },
        },
        "drift_refactor": {
            "type": "noul",
            "instructions": ("Does `diff` contain cleanup, refactoring, renaming, or restructuring "
                             "that `objectives` do not ask for?"),
        },
        "drift_deps": {
            "type": "noul",
            "instructions": "Does `diff` add a dependency that `objectives` do not ask for?",
        },
        "drift_tests_docs": {
            "type": "noul",
            "instructions": "Does `diff` add tests, documentation, or comments that `objectives` do not ask for?",
        },
        "drift_behavior": {
            "type": "noul",
            "instructions": (
                "Does `diff` change behavior beyond what `objectives` ask for? Behavior "
                "that `objectives` ask for but `diff` has not finished yet does not count."
            ),
        },
        "drift_substitute": {
            "type": "noul",
            "instructions": "Does `diff` substitute a related improvement for the result `objectives` ask for?",
        },
    }


def completion_questions():
    return {
        "met": {
            "type": "noul",
            "instructions": (
                "Does `diff` fully implement `objective`? `diff` is the whole change since "
                "the task began, limited to the files `objective` lists."
            ),
        },
    }


def chunks(state, file_diff, questions):
    """Split one file's diff into requests that fit. None if one hunk cannot."""
    if jev.fits({**state, "diff": file_diff}, questions):
        return [file_diff]
    parts = re.split(r"(?m)^(?=@@)", file_diff)
    header, hunks = parts[0], parts[1:]
    groups, current = [], header
    for hunk in hunks:
        candidate = current + hunk
        if jev.fits({**state, "diff": candidate}, questions):
            current = candidate
            continue
        if current == header:
            return None
        groups.append(current)
        current = header + hunk
        if not jev.fits({**state, "diff": current}, questions):
            return None
    groups.append(current)
    return groups


def scope(root, goal, tree, head):
    """Per changed file since HEAD: [{path, verdict, confidence, drift{...}}].

    Jev sees only the objectives that list the file, plus every rule and
    out-of-scope item: a smaller request, and the part of the goal that applies.
    """
    text = diff(root, "HEAD", tree, context=CFG["diff.scope_context_lines"])
    if text is None:
        die(EXIT_ESCALATE, "ESCALATE: could not diff the change against HEAD.")
    questions = scope_questions()
    rules = [f"{r.id}: {r.text}" for r in goal.rules]
    out_of_scope = [f"{x.id}: {x.text}" for x in goal.out_of_scope]
    results = []
    for path, file_diff in split_files(text):
        state = {
            "objectives": [o.render() for o in goalfmt.owners(goal, path)],
            "rules": rules,
            "out_of_scope": out_of_scope,
            "file": path,
        }
        parts = chunks(state, file_diff, questions)
        if parts is None:
            die(EXIT_ESCALATE,
                f"ESCALATE: a change in {path} is too large to check in one request.",
                "It was NOT checked and NOT truncated. Nothing was committed.",
                "NEXT: ask the user: the change is too large for Jev; they decide how to split it.")
        worst = None
        for n, part in enumerate(parts, 1):
            answers = jev.ask({**state, "diff": part}, questions, "scope",
                              {"file": path, "part": f"{n}/{len(parts)}", "head": head, "tree": tree})
            result = {
                "path": path,
                "verdict": answers["verdict"]["choice"],
                "confidence": answers["verdict"]["confidence"],
                "drift": {k: answers[k]["noul"] for k in DRIFT_KEYS},
                "parts": len(parts),
            }
            worst = result if worst is None else worse(worst, result)
        results.append(worst)
    return results


def worse(a, b):
    """The part that decides the gate: the most confident outside_scope, else the least confident."""
    drift = {k: max(a["drift"][k], b["drift"][k]) for k in DRIFT_KEYS}
    a_out, b_out = a["verdict"] == "outside_scope", b["verdict"] == "outside_scope"
    if a_out != b_out:
        pick = a if a_out else b
    elif a_out:
        pick = a if a["confidence"] >= b["confidence"] else b
    else:
        pick = a if a["confidence"] <= b["confidence"] else b
    return {**pick, "drift": drift}


def judge_scope(results):
    """(blocked files, tripped drifts, unsure files, max drift) from scope results."""
    drift = {k: max((r["drift"][k] for r in results), default=0.0) for k in DRIFT_KEYS}
    blocked = [r["path"] for r in results
               if r["verdict"] == "outside_scope" and r["confidence"] >= CFG["scope.block_verdict_confidence"]]
    unsure = [r["path"] for r in results
              if r["path"] not in blocked and r["confidence"] < CFG["scope.min_verdict_confidence"]]
    tripped = {k: v for k, v in drift.items() if v >= CFG["scope.drift_block"]}
    return blocked, tripped, unsure, drift


def completion(root, goal, base, tree, previous):
    """{id: record} for every objective, against the whole change since `base`.

    Each objective sees only its own files, with whole enclosing functions when
    they fit and a few lines of context when they do not. A record is reused
    while the objective's text and its diff are unchanged.
    """
    changed = changed_paths(root, base, tree)
    questions = completion_questions()
    records = {}
    for objective in goal.objectives:
        files = [p for p in changed if any(goalfmt.matches(f, p) for f in objective.files)]
        if not files:
            records[objective.id] = {"state": "pending", "reason": "no changes in its files yet", "files": []}
            continue
        state = {"objective": objective.render()}
        text = diff(root, base, tree, files, function=True)
        mode = "function"
        if text is not None and not jev.fits({**state, "diff": text}, questions):
            text = diff(root, base, tree, files, context=CFG["diff.completion_fallback_lines"])
            mode = f"U{CFG['diff.completion_fallback_lines']}"
        if text is None:
            die(EXIT_ESCALATE, f"ESCALATE: could not diff {objective.id}'s files.")
        key = text_hash(objective.render() + "\n" + text)
        old = previous.get(objective.id, {})
        if old.get("key") == key and old.get("state") in ("met", "not_met", "unchecked"):
            records[objective.id] = old
            continue
        tokens = jev.request_tokens({**state, "diff": text}, questions)
        if tokens > jev.budget():
            records[objective.id] = {
                "state": "unchecked", "key": key, "files": files, "at": now(),
                "reason": f"too large: about {tokens} tokens, limit {int(jev.budget())}",
            }
            continue
        answers = jev.ask({**state, "diff": text}, questions, "completion",
                          {"id": objective.id, "base": base, "tree": tree, "files": files, "diff": mode})
        score = answers["met"]["noul"]
        records[objective.id] = {
            "state": "met" if score >= CFG["completion.item_complete"] else "not_met",
            "score": score, "key": key, "files": files, "diff": mode, "at": now(),
        }
    return records


def run_verify(root, goal, tree, previous, log_dir):
    """{id: record}. Runs only when every objective is met; a pass is reused for the same tree."""
    records = {}
    for check in goal.verify:
        old = previous.get(check.id, {})
        if old.get("state") == "passed" and old.get("tree") == tree and old.get("command") == check.command:
            records[check.id] = old
            continue
        result = verify.run_check(check, root, log_dir,
                                  CFG["verify.timeout_seconds"], CFG["verify.requires_timeout_seconds"])
        records[check.id] = {**result, "tree": tree, "at": now()}
    return records


def waiting_verify(goal):
    return {c.id: {"state": "pending", "reason": "waits for every objective to be met"} for c in goal.verify}
