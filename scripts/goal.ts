#!/usr/bin/env node
/*
Task Goal: write, check and record the goal a task-contract task executes.

Structure is checked in plain code. Wording is judged by Jev. Tunables live in
config.json at the repository root.

Modes (goal text on stdin, verbatim):
  --check                 Check a draft. Creates nothing.
  --record --slug <slug>  Record a goal the user approved word for word. Creates a ready task.
  --revise                Record a new version the user approved word for word.

Exit codes:
  0  ready / recorded
  2  escalate to the user
  3  not ready, or a precondition failed
*/

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as clarity from "../lib/core/clarity.ts";
import { EXIT_PASS, EXIT_PRECONDITION, die, now, out, paths, readStdin, run, textHash, today } from "../lib/core/common.ts";
import * as config from "../lib/core/config.ts";
import * as goalfmt from "../lib/core/goalfmt.ts";
import type { Goal } from "../lib/core/goalfmt.ts";
import { git, gitRoot, optionalRoot } from "../lib/core/gitutil.ts";
import * as jev from "../lib/core/jev.ts";
import * as tasks from "../lib/core/tasks.ts";

// [goal, notes] or stop with every structural error. Plain code only.
function structure(text: string, root: string | null): [Goal, string[]] {
  const [goal, errors] = goalfmt.parse(text);
  if (root !== null && goal.repo && goal.repo !== path.basename(root)) {
    errors.push(`Repo: says '${goal.repo}', but this repository is '${path.basename(root)}'. ` +
      "A task covers one repository.");
  }
  if (errors.length) {
    die(EXIT_PRECONDITION,
      "NOT READY: the goal does not follow the format. Nothing was sent to Jev.",
      ...errors.map((e) => `  - ${e}`));
  }
  const notes: string[] = [];
  if (root !== null) {
    const [, tracked] = git(root, ["ls-files"]);
    const existing = tracked.split("\n").filter(Boolean);
    for (const objective of goal.objectives) {
      for (const pattern of objective.files) {
        if (/[*?]/.test(pattern) || pattern.endsWith("/")) {
          if (!existing.some((p) => goalfmt.matches(pattern, p))) {
            notes.push(`${objective.id}: '${pattern}' matches no tracked file yet.`);
          }
        } else if (!existsSync(path.join(root, pattern))) {
          notes.push(`${objective.id}: '${pattern}' does not exist yet (fine if the task creates it).`);
        }
      }
    }
  }
  return [goal, notes];
}

const noteLines = (notes: string[]) => (notes.length ? ["", "Notes:", ...notes.map((n) => `  ${n}`)] : []);

async function cmdCheck() {
  const text = readStdin();
  if (!text) die(EXIT_PRECONDITION, "PRECONDITION FAILED: no goal on stdin.");
  const root = optionalRoot();
  const [goal, notes] = structure(text, root);
  const [ok, report] = await clarity.check(text, goal);
  out((ok ? "READY" : "NOT READY") + `: ${goal.objectives.length} objectives, ` +
    `${goal.rules.length} rules, ${goal.out_of_scope.length} out of scope, ${goal.verify.length} verify.`,
  ...report,
  ...noteLines(notes),
  root ? "" : "Not inside a git repository: Repo: and Files: were not checked against it.");
  if (!ok) {
    out("Show the user what is not ready. Record nothing until they approve new wording.");
    return EXIT_PRECONDITION;
  }
  out("Show the user the full goal. Record it only after they approve this exact text:",
    "  goal.ts --record --slug <slug>");
  return EXIT_PASS;
}

async function cmdRecord(slugArg: string) {
  const root = gitRoot();
  const text = readStdin();
  if (!text) die(EXIT_PRECONDITION, "PRECONDITION FAILED: no goal on stdin.", "Pipe the goal the user approved, verbatim.");
  const openTasks = tasks.find(root);
  if (openTasks.length) {
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: this repository already has an open task.",
      "To change its goal, use goal.ts --revise. To start over, the user closes it first (check.ts --close).",
      ...openTasks.map((t) => `  ${t}`));
  }
  const [goal, notes] = structure(text, root);
  const [ok, report, results] = await clarity.check(text, goal);
  if (!ok) die(EXIT_PRECONDITION, "NOT READY: nothing was recorded.", ...report);

  const slug = tasks.slugify(slugArg) || tasks.slugify(goal.title);
  if (!slug) die(EXIT_PRECONDITION, "PRECONDITION FAILED: --slug produced an empty name.");
  const task = tasks.create(root, slug, today());
  const goalText = text + "\n";
  tasks.writeGoal(task, goalText, 1, goal);
  tasks.writeMeta(task, {
    id: path.basename(task),
    slug,
    repo: root,
    base_commit: null,
    goal_version: 1,
    goal_hash: textHash(goalText),
    retired_ids: [],
    config_hash: config.configHash(),
    config: tasks.snapshotConfig(),
    created: now(),
    status: "ready",
  });
  tasks.writeState(task, tasks.freshState(goal));
  tasks.event(task, "record", { version: 1, clarity: results, notes });
  out(`RECORDED  ${path.basename(task)}`,
    ...report,
    ...noteLines(notes),
    "",
    `Goal:  ${path.join(task, "goal.md")}`,
    "The task is ready. Start it with task-contract:",
    `  node ${paths.checkCli} --start`);
  return EXIT_PASS;
}

async function cmdRevise() {
  const root = gitRoot();
  const task = tasks.resolve(root);
  const meta = tasks.readMeta(task)!;
  tasks.verifiedConfig(task, meta);
  const text = readStdin();
  if (!text) {
    die(EXIT_PRECONDITION, "PRECONDITION FAILED: no goal on stdin.",
      "Pipe the complete new version the user approved, verbatim.");
  }
  let version = meta.goal_version;
  const oldText = readFileSync(path.join(task, `goal.v${version}.md`), "utf8");
  if (text + "\n" === oldText) {
    if (readFileSync(path.join(task, "goal.md"), "utf8") !== oldText) {
      tasks.writeGoal(task, oldText, version, goalfmt.parse(oldText)[0]);
      out("goal.md was restored to the recorded version. Nothing else changed.");
    } else {
      out("Nothing changed: this is the recorded version.");
    }
    return EXIT_PASS;
  }
  const [old] = goalfmt.parse(oldText);
  const [goal, notes] = structure(text, root);
  const reused = goalfmt.ids(goal).filter((id) => (meta.retired_ids ?? []).includes(id));
  if (reused.length) {
    die(EXIT_PRECONDITION,
      "NOT READY: these IDs were removed in an earlier version and are never reused:",
      `  ${reused.join(", ")}`,
      "Give the new items new numbers.");
  }
  const changes = goalfmt.compare(old, goal);
  if (!changes.length) changes.push("wording outside the items changed");
  const [ok, report, results] = await clarity.check(text, goal);
  if (!ok) {
    tasks.event(task, "revise-reject", { version: version + 1, changes, clarity: results });
    die(EXIT_PRECONDITION, "NOT READY: the new version was not recorded.", ...report);
  }

  version += 1;
  const goalText = text + "\n";
  tasks.writeGoal(task, goalText, version, goal);
  const removed = changes.filter((c) => c.endsWith(" removed")).map((c) => c.split(" ")[0]);
  const touched = new Set(changes.filter((c) => c.endsWith(" changed") || c.endsWith(" added")).map((c) => c.split(" ")[0]));
  const state = tasks.readState(task);
  for (const group of [state.objectives ?? {}, state.verify ?? {}]) {
    for (const id of touched) delete group[id];
  }
  tasks.writeState(task, tasks.freshState(goal, state));
  meta.goal_version = version;
  meta.goal_hash = textHash(goalText);
  meta.retired_ids = [...new Set([...(meta.retired_ids ?? []), ...removed])].sort();
  tasks.writeMeta(task, meta);
  tasks.event(task, "revise", { version, changes, clarity: results, notes });
  out(`REVISED  ${path.basename(task)}  now version ${version}`,
    ...changes.map((c) => `  ${c}`),
    ...report,
    ...noteLines(notes),
    "",
    "Any earlier pass is void, and changed objectives are checked again.",
    `Goal: ${path.join(task, "goal.md")}`);
  return EXIT_PASS;
}

const USAGE = "usage: goal.ts (--check | --record --slug <slug> | --revise) [--session <id>]";

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        check: { type: "boolean" },
        record: { type: "boolean" },
        revise: { type: "boolean" },
        slug: { type: "string", default: "" },
        session: { type: "string", default: "" },
      },
    }));
  } catch (err) {
    die(2, USAGE, err instanceof Error ? err.message : String(err));
  }
  const modes = (["check", "record", "revise"] as const).filter((m) => values[m]);
  if (modes.length !== 1) die(2, USAGE);
  jev.session.id = values.session!;
  config.load();
  if (values.check) return cmdCheck();
  if (values.record) return cmdRecord(values.slug!);
  return cmdRevise();
}

if (import.meta.main) await run(main);
