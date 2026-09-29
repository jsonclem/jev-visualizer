---
name: task-contract
description: Run a coding task under a recorded goal. Every change is checked against the goal's objectives, rules and files before a local commit, each objective is checked off as it is met, and the goal's verify commands decide when it is done. Use only when the user asks for task-contract, a task contract, or scope-gated execution of a task in a git repository.
---

# Task Contract

`CHECK` is `node /Users/jasonclements/Desktop/task-contract/scripts/check.ts`.

`CHECK` decides whether work is in scope, which objectives are met, and what
happens next. You execute its decisions. Act on its exit code and its `NEXT:`
line, and nothing else. Treat any exit code not listed below as 2.

Every check sends goal items and the changed lines to TypeSafe's Jev API
(api.typesafe.ai). Do not use this skill on code that must not leave the
machine unless the user has accepted that.

## Start the task

1. The goal comes from task-goal. If this repository has no recorded goal,
   use task-goal first.
2. Run `CHECK --start`. It starts the ready task (the working tree must be
   clean) or resumes the active one.
3. Exit 0: read the goal file it prints, then follow its `NEXT:` line.
4. Exit 3: stop and report its output. Change nothing.

## For each step

A step is one coherent change toward the objective `NEXT:` names, not every
file save. Change only files listed on an objective's `Files:` line.

A task can cover several repositories. Run `CHECK` from inside any of them:
it checks the changes in all of them, and `CHECK --commit` commits each
repository that has changes, with the same message.

1. Make the change.
2. Run `CHECK`.
3. Act on the exit code:
   - 0: run `CHECK --commit -m "<message>"`. Then:
     - GOAL COMPLETE: stop. The commit closed the task.
     - Otherwise follow the `NEXT:` line it prints.
   - 1: stop. Show the user the output and the proposed revert. Run the revert
     only after the user explicitly approves it. Do not commit.
   - 2: stop and report. Do not revert. Do not commit.
   - 3: stop and report. Change nothing.

## The NEXT line

- `work on O<n> ...`: make the next step toward that objective.
- `fix V<n> ...`: read the log it names and fix the cause, within the goal.
- `ask the user: ...`: stop and ask exactly that. Do not work around it.
- `commit; this closes the task`: run `CHECK --commit`.
- `none: the task is complete`: stop.

After the user resolves an `ask the user` about Verify (for example by
starting a service), run `CHECK` again even if nothing changed: it re-checks
the committed work.

## Rules

- Never push. Commit only through `CHECK --commit`: never plain `git commit`,
  never `--no-verify`. While a task is active, a pre-commit hook rejects every
  commit not made through `CHECK --commit`.
- goal.md is the user's approved goal. Never edit it; it is read-only on
  purpose. When the user corrects or adds to the goal, change it with
  task-goal (`goal.ts --revise`), never by hand.
- If goal.md was edited outside the scripts, `CHECK` stops with exit 3.
- config.json (at /Users/jasonclements/Desktop/task-contract) holds every
  threshold and the handoff point. Only the user changes it. Never edit it. If
  it changes mid-task, `CHECK` stops with exit 3. Run `CHECK --accept-config`
  only when the user tells you to.
- Run `CHECK --close` only when the user asks to stop or abandon the task.
- Commit messages are short, plain, and human: no agent name, no attribution
  trailer, no emoji.
- The task folder's state.json, events.jsonl, jev.jsonl and verify logs are
  written by the scripts. Do not write to them. They record progress; they do
  not authorize additional work.

## Handing off to a new session

Report what is complete, what remains, and the next action. Use supported
session tools when available. The previous session stops editing. The new
session runs `CHECK --start` to resume, then continues from "For each step".
It reports any uncommitted changes; run `CHECK` on them before committing.

Hand off at the context usage `CHECK --start` prints on its `Handoff:` line,
and only when reliable usage information is available. Do not invent it.
