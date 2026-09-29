---
name: task-contract
description: Run a coding task under a recorded contract. The user's instructions are saved verbatim, and every change is scope-checked against them before a local commit. Use only when the user asks for task-contract, a task contract, or scope-gated execution of a task in a git repository.
---

# Task Contract

`CHECK` is `python3 /Users/jasonclements/Desktop/task-contract/skill/scripts/check.py`.

`CHECK` decides whether work is in scope. You execute its decisions. Act on its
exit code, and after a commit on the completion line it prints, and nothing
else. Treat any exit code not listed below as 2.

Every check sends the goal and the changed lines to TypeSafe's Jev API
(api.typesafe.ai). Do not use this skill on code that must not leave the
machine unless the user has accepted that.

## Start the task

1. Run `CHECK --init --slug <short-task-slug>`, piping the user's instructions to
   stdin verbatim. Pipe only the task instructions, unchanged: leave out the
   request to use this skill.
2. Exit 0: continue. It prints the goal file path.
3. Exit 3: stop and report its output. Change nothing.
   If the goal failed the clarity check, you may propose sharper wording in
   chat. Pipe it to `--init` only after the user approves that exact text.

## For each step

A step is one coherent change toward the goal, not every file save.

1. Read the goal file.
2. Make the change.
3. Run `CHECK`.
4. Act on the exit code:
   - 0: run `CHECK --commit -m "<message>"`. Then:
     - GOAL COMPLETE: stop. The commit closed the task.
     - COMPLETION NOT CHECKED: stop and ask the user whether the goal is complete.
     - Otherwise return to step 1. If the goal asks for no further change,
       stop and ask the user whether it is complete.
   - 1: stop. Show the user the output and the proposed revert. Run the revert
     only after the user explicitly approves it. Do not commit.
   - 2: stop and report. Do not revert. Do not commit.
   - 3: stop and report. Change nothing.

Never push. Commit only through `CHECK --commit`: never plain `git commit`,
never `--no-verify`. While a task is active, a pre-commit hook rejects every
commit not made through `CHECK --commit`.

## Rules

- goal.txt holds the user's instructions verbatim. Only the user changes it.
  Never edit it; it is read-only on purpose.
- When the user corrects or adds to the goal, pipe their words verbatim to
  `CHECK --amend`. Do not paraphrase them.
- If the user edits goal.txt by hand, `CHECK` stops with exit 3. Run
  `CHECK --accept-goal` only when the user tells you to.
- config.json (next to this file) holds every threshold and the handoff point.
  Only the user changes it. Never edit it. If it changes mid-task, `CHECK`
  stops with exit 3. Run `CHECK --accept-config` only when the user tells you to.
- Run `CHECK --close` only when the user asks to stop or abandon the task.
- Keep the recorded goal as the reference throughout your reasoning and actions.
- Commit messages are short, plain, and human: no agent name, no attribution
  trailer, no emoji.
- `CHECK` writes history.txt (each event with the scores behind it) and
  jev.jsonl (every Jev request's questions and full answers). Do not write to
  either. They record progress; they do not authorize additional work.

## Handing off to a new session

Report what is complete, what remains, and the next action. Use supported
session tools when available. The previous session stops editing. The new
session runs `CHECK --init --slug <same-slug>` with nothing on stdin to resume,
then continues from "For each step". It reports any uncommitted changes; run
`CHECK` on them before committing.

Hand off at the context usage `CHECK --init` prints on its `Handoff:` line,
and only when reliable usage information is available. Do not invent it.
