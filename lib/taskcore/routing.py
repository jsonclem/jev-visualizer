"""The NEXT line. Jev's judgments go in; a fixed table decides what happens next.

Pure: no files, no git, no Jev. Every branch is covered by tests/test_routing.py.
"""

from .common import EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS

REVERT = 'git stash push -u -m "task-contract: blocked change"'


def decide(*, uncovered=(), blocked=False, unsure=(), verify_changed=(), objectives=(), verify=(),
           has_changes=True):
    """(exit code, next line, complete).

    `objectives` and `verify` are [(id, record)] in goal order. A record has a
    `state`, and may have `score`, `reason`, `exit` and `log`. `verify_changed`
    lists files the Verify commands created or changed.
    """
    if uncovered:
        return (EXIT_BLOCK,
                f"ask the user: {', '.join(uncovered)} not listed in any objective's Files. "
                f"Revert only if they approve ({REVERT}), or they revise the goal with task-goal to list it.",
                False)
    if blocked:
        return (EXIT_BLOCK,
                f"ask the user: show them this block. Revert only if they approve ({REVERT}).",
                False)
    if unsure:
        return (EXIT_ESCALATE,
                f"ask the user: Jev is not confident enough about {', '.join(unsure)}. They decide.",
                False)
    if verify_changed:
        return (EXIT_ESCALATE,
                f"ask the user: Verify changed {', '.join(verify_changed)}. They ignore it "
                "(.gitignore) or change the command; then run check.py again.",
                False)

    by_state = {}
    for oid, record in objectives:
        by_state.setdefault(record["state"], []).append((oid, record))

    if "unchecked" in by_state:
        oid, record = by_state["unchecked"][0]
        return (EXIT_PASS,
                f"ask the user: {oid} couldn't be checked ({record.get('reason', 'unknown reason')}). "
                "They can split it with task-goal --revise.",
                False)
    if "not_met" in by_state:
        oid, record = by_state["not_met"][0]
        return EXIT_PASS, f"work on {oid} (not met, {record.get('score', 0):.2f})", False
    if "pending" in by_state:
        oid, _ = by_state["pending"][0]
        return EXIT_PASS, f"work on {oid} (not started)", False

    failed = [(vid, r) for vid, r in verify if r["state"] == "failed"]
    if failed:
        vid, record = failed[0]
        return (EXIT_PASS,
                f"fix {vid} ({record.get('reason', 'failed')}, log: {record.get('log', 'none')})",
                False)
    blocked_runs = [(vid, r) for vid, r in verify if r["state"] in ("couldnt_run", "pending")]
    if blocked_runs:
        vid, record = blocked_runs[0]
        return (EXIT_PASS,
                f"ask the user: {vid} couldn't run ({record.get('reason', 'not run')}).",
                False)

    if has_changes:
        return EXIT_PASS, "commit; this closes the task", True
    return EXIT_PASS, "none: the task is complete", True
