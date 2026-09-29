/*
The task folder under history/. Plain code: which task, which goal, what state.

    goal.md          current goal, read-only
    goal.v<N>.md     every approved version, read-only
    goal.json        current goal parsed, for the viewer
    meta.json        identity, status, goal and config fingerprints
    state.json       status of every objective and Verify command, and the last passing tree
    events.jsonl     every event, one JSON object per line
    jev.jsonl        every Jev question and answer
    verify/*.log     output of Verify commands that failed or couldn't run
*/

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { EXIT_PRECONDITION, die, now, paths, textHash } from "./common.ts";
import { CFG, changes as configChanges, configHash, type Config } from "./config.ts";
import * as goalfmt from "./goalfmt.ts";
import type { Goal } from "./goalfmt.ts";
import * as jev from "./jev.ts";
import { git, gitPath } from "./gitutil.ts";

export const ACTIVE = ["ready", "active"]; // a repository has at most one task in these states

export type Meta = {
  id: string;
  slug: string;
  repo: string;
  base_commit: string | null;
  goal_version: number;
  goal_hash: string;
  retired_ids: string[];
  config_hash: string;
  config: Config;
  created: string;
  status: string;
  started?: string;
  closed?: string;
};

export type Record_ = { state: string; reason?: string; score?: number; [key: string]: unknown };

export type State = {
  objectives: Record<string, Record_>;
  verify: Record<string, Record_>;
  last_pass: string | null;
  last_pass_complete: boolean;
  next: string | null;
};

export function slugify(text: string) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40).replace(/^-+|-+$/g, "");
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown) {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function readMeta(task: string) {
  return readJson<Meta | null>(path.join(task, "meta.json"), null);
}

export function writeMeta(task: string, meta: Meta) {
  writeJson(path.join(task, "meta.json"), meta);
}

export function readState(task: string) {
  return readJson<State>(path.join(task, "state.json"), {} as State);
}

export function writeState(task: string, state: State) {
  writeJson(path.join(task, "state.json"), state);
}

export function event(task: string, name: string, detail: Record<string, unknown> = {}) {
  const record = { at: now(), event: name, ...(jev.session.id ? { session: jev.session.id } : {}), ...detail };
  appendFileSync(path.join(task, "events.jsonl"), JSON.stringify(record) + "\n");
}

export function find(root: string, statuses: string[] = ACTIVE) {
  if (!existsSync(paths.tasks) || !statSync(paths.tasks).isDirectory()) return [];
  const matches: string[] = [];
  for (const name of readdirSync(paths.tasks).sort()) {
    const candidate = path.join(paths.tasks, name);
    if (name.startsWith("_") || name.startsWith(".") || !statSync(candidate).isDirectory()) continue;
    const meta = readMeta(candidate);
    if (meta && meta.repo === root && statuses.includes(meta.status)) matches.push(candidate);
  }
  return matches;
}

// The one task for this repository in `statuses`. No agent input decides it.
export function resolve(root: string, statuses: string[] = ACTIVE) {
  const matches = find(root, statuses);
  if (!matches.length) {
    die(EXIT_PRECONDITION,
      `PRECONDITION FAILED: no ${statuses.join(" or ")} task for this repository.`,
      `Repository: ${root}`,
      "Record a goal first with task-goal (goal.ts --record).");
  }
  if (matches.length > 1) {
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: more than one open task for this repository.",
      "The user must close one before work continues.",
      ...matches.map((m) => `  ${m}`));
  }
  jev.setTask(matches[0]);
  return matches[0];
}

export function create(root: string, slug: string, day: string) {
  const base = `${day}-${path.basename(root)}-${slug}`;
  let task = path.join(paths.tasks, base);
  let counter = 2;
  while (existsSync(task)) {
    task = path.join(paths.tasks, `${base}-${counter}`);
    counter += 1;
  }
  mkdirSync(task, { recursive: true });
  jev.setTask(task);
  return task;
}

function writeReadonly(file: string, text: string) {
  if (existsSync(file)) chmodSync(file, 0o644);
  writeFileSync(file, text);
  chmodSync(file, 0o444);
}

// goal.md and each goal.v<N>.md are read-only, so a stray edit fails loudly.
export function writeGoal(task: string, text: string, version: number, goal: Goal) {
  writeReadonly(path.join(task, `goal.v${version}.md`), text);
  writeReadonly(path.join(task, "goal.md"), text);
  writeJson(path.join(task, "goal.json"), { version, ...goalfmt.toDict(goal) });
}

// The current goal, provided nobody changed goal.md outside the scripts.
export function loadGoal(task: string, meta: Meta): [string, Goal] {
  const file = path.join(task, "goal.md");
  const text = readFileSync(file, "utf8");
  if (textHash(text) !== meta.goal_hash) {
    event(task, "goal-changed", { detail: "goal.md edited outside the scripts; work stopped" });
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: goal.md changed outside the scripts.",
      "If the user edited it, they approve it as a new version with task-goal:",
      `  node ${paths.goalCli} --revise < '${file}'`,
      "If they did not, the edit is not theirs: report it and change nothing.",
      `Goal: ${file}`);
  }
  const [goal, errors] = goalfmt.parse(text);
  if (errors.length) {
    die(EXIT_PRECONDITION, "PRECONDITION FAILED: the recorded goal no longer parses.", ...errors.map((e) => `  - ${e}`));
  }
  return [text, goal];
}

// Stop if the thresholds moved since this task last accepted them.
export function verifiedConfig(task: string, meta: Meta) {
  if (meta.config_hash === configHash()) return;
  const changes = configChanges(meta.config ?? {});
  event(task, "config-changed", { detail: "config.json changed mid-task; work stopped", changes });
  die(EXIT_PRECONDITION,
    "PRECONDITION FAILED: config.json changed since this task last ran.",
    ...changes,
    "",
    "If the user made this change, they tell you to run check.ts --accept-config.",
    "If they did not, the change is not theirs: report it and change nothing.",
    `Config: ${paths.config}`);
}

// State for a goal version. Entries whose ID survives keep their record;
// goal.ts clears the ones whose text changed before calling this.
export function freshState(goal: Goal, old: Partial<State> = {}): State {
  const objectives = old.objectives ?? {};
  const verify = old.verify ?? {};
  return {
    objectives: Object.fromEntries(goal.objectives.map((o) =>
      [o.id, objectives[o.id] ?? pending("no changes in its files yet")])),
    verify: Object.fromEntries(goal.verify.map((c) =>
      [c.id, verify[c.id] ?? pending("waits for every objective to be met")])),
    last_pass: null,
    last_pass_complete: false,
    next: null,
  };
}

export function pending(reason: string): Record_ {
  return { state: "pending", reason };
}

export function snapshotConfig() {
  return { ...CFG };
}

export const HOOK_MARK = "# task-contract pre-commit hook";

// Reject commits the gate did not pass while a task is active.
//
// Never replaces a hook it did not write. Inert when no task is active. The
// hook names this Node binary, so a Git app whose PATH lacks node still runs it.
export function installHook(root: string, checkPath: string) {
  const [, hooksPath] = git(root, ["config", "core.hooksPath"]);
  if (hooksPath.trim()) return "WARNING: core.hooksPath is set; no hook installed. Direct commits are not blocked.";
  const hook = gitPath(root, "hooks/pre-commit");
  if (existsSync(hook) && !readFileSync(hook, "utf8").includes(HOOK_MARK)) {
    return `WARNING: ${hook} exists and was left alone. Direct commits are not blocked.`;
  }
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook,
    "#!/bin/sh\n" +
    `${HOOK_MARK}\n` +
    "# Rejects commits the task-contract gate did not pass while a task is active.\n" +
    `CHECK="${checkPath}"\n` +
    `NODE="${process.execPath}"\n` +
    '[ -f "$CHECK" ] || exit 0\n' +
    '[ -x "$NODE" ] || NODE=node\n' +
    'exec "$NODE" "$CHECK" --hook\n');
  chmodSync(hook, 0o755);
  return `Hook:    ${hook}`;
}
