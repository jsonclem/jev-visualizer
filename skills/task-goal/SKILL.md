---
name: task-goal
description: Write, check and record the goal for a task-contract task. Turns a request into a goal with numbered objectives, rules, out-of-scope items and verify commands, checks it, and records it only after the user approves the exact text. Use only when the user asks for task-goal, a task goal, or a task-contract task.
---

# Task Goal

`GOAL` is `node /Users/jasonclements/Desktop/task-contract/scripts/goal.ts`.

A goal is what a task-contract task is held to. `GOAL` checks its structure in
plain code and its wording with TypeSafe's Jev API (api.typesafe.ai), then
records it. Every check sends the goal text to Jev. Do not use this skill on
text that must not leave the machine unless the user has accepted that.

## The format

```markdown
# <title>
Repo: <repository folder name>
<optional one-paragraph summary>

## Objectives

### O1 <optional short title>
Files: <path>, <path or pattern>
<one condition that will be true when this objective is done>

## Rules
- R1: <a limit on how the work is done, or what must stay the same>

## Out of scope
- X1: <something not to change>

## Verify
- V1: <shell command run from the repository root; exit 0 means pass>
  Requires: <optional shell command; if it fails, V1 couldn't run rather than failed>
```

- Objectives are the only items that count toward done. Each is one condition
  that can be judged by reading changes to the files on its `Files:` line.
- `Files:` lists every file the objective may change. A file no objective lists
  cannot be changed. Patterns: `*` within a folder, `**` across folders, and a
  path with no wildcard also covers everything under it as a folder.
- Rules and Out of scope limit the work. They are never objectives.
- Verify holds the commands that prove the work, such as the tests to run.
  Use `Requires:` for what they need running, such as a database.
- IDs are never renumbered. A removed ID is never reused.

## Writing a goal

1. If the user gives a rough request, draft the goal in this format. Use only
   what the user asked for; do not add objectives, rules or commands they did
   not ask for. Ask about anything you would otherwise have to decide.
   If the user gives a goal already in this format, use it unchanged.
2. Run `GOAL --check`, piping the draft to stdin. It creates nothing.
3. Exit 3: show the user what is not ready and propose new wording.
4. Exit 0: show the user the complete goal text.
5. Record it only after the user approves that exact text:
   `GOAL --record --slug <short-task-slug>`, piping the approved text to stdin.
   Exit 0 creates a ready task. Exit 3: report it and record nothing.

Never record text the user has not approved word for word: unapproved wording
is your scope, not theirs.

## Changing a goal

Write the complete new version, keeping every unchanged item and its ID. Show
it to the user. After they approve that exact text, pipe it to `GOAL --revise`.
It reports which IDs changed, were added or were removed. Exit 3: nothing was
recorded; report it.

If the user edited `goal.md` by hand and tells you to accept it, pipe that
file to `GOAL --revise`.

## After recording

Start the task with task-contract (`check.ts --start`).
