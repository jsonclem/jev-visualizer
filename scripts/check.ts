#!/usr/bin/env node
/*
Task Contract gate.

Jev decides judgments. This script decides facts and what happens next. The
goal is recorded by task-goal (goal.ts); tunables live in config.json at the
repository root.

Modes:
  --start                 Start the ready task for this repository (and the task's other
                          repositories), or resume the active one.
  (no arguments)          Gate the change, check each objective, run Verify, print NEXT.
  --commit -m <message>   Commit the gated change locally. Never pushes.
  --accept-config         Accept config.json values the user changed mid-task.
  --close                 Close the open task without completing it.
  --hook                  pre-commit hook entry point. Not for direct use.

Exit codes:
  0  pass; follow the NEXT line after committing
  1  blocked; the user decides whether to revert
  2  escalate to the user
  3  precondition failed
*/

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS, EXIT_PRECONDITION, die, fixed, now, out, run } from "../lib/core/common.ts";
import * as config from "../lib/core/config.ts";
import { num } from "../lib/core/config.ts";
import * as gate from "../lib/core/gate.ts";
import * as goalfmt from "../lib/core/goalfmt.ts";
import type { Goal } from "../lib/core/goalfmt.ts";
import {
  changedPaths, git, gitRoot, headSha, headTree, reachable, requireClean, snapshot, usesConventionalCommits,
} from "../lib/core/gitutil.ts";
import * as jev from "../lib/core/jev.ts";
import { fromPaths, qualify, type Repos } from "../lib/core/repos.ts";
import * as routing from "../lib/core/routing.ts";
import * as tasks from "../lib/core/tasks.ts";
import type { Meta, Record_, State } from "../lib/core/tasks.ts";

const CHECK_PATH = fileURLToPath(import.meta.url);
const COMMIT_ENV = "TASK_CONTRACT_COMMIT"; // set by --commit to the gated tree; the hook requires it

const MARK: Record<string, string> = {
  met: "✓", not_met: "✗", unchecked: "⊘", pending: "◇",
  passed: "✓", failed: "✗", couldnt_run: "⊘",
};

function openTask(root: string, statuses = ["active"]): [string, Meta] {
  const task = tasks.resolve(root, tasks.ACTIVE);
  const meta = tasks.readMeta(task)!;
  if (!statuses.includes(meta.status)) {
    die(EXIT_PRECONDITION,
      `PRECONDITION FAILED: task ${meta.id} is ${meta.status}, not started.`,
      `Start it with: node ${CHECK_PATH} --start`);
  }
  return [task, meta];
}

function objectiveLines(goal: Goal, records: Record<string, Record_>) {
  return goal.objectives.map((objective) => {
    const record = records[objective.id] ?? { state: "pending" };
    const state = record.state;
    let detail: string;
    if (state === "met" || state === "not_met") {
      detail = `${(state === "met" ? "met" : "not met").padEnd(8)} ${fixed(record.score!)}`;
    } else if (state === "unchecked") {
      detail = `couldn't check: ${record.reason}`;
    } else {
      detail = `not started (${record.reason ?? "no changes yet"})`;
    }
    return `  ${MARK[state]} ${objective.id.padEnd(4)} ${detail}`;
  });
}

function verifyLines(goal: Goal, records: Record<string, Record_>) {
  return goal.verify.map((check) => {
    const record = records[check.id] ?? { state: "pending" };
    const state = record.state;
    let detail: string;
    if (state === "passed") detail = `passed (${record.seconds ?? 0}s)`;
    else if (state === "failed") detail = `failed: ${record.reason}  log: ${record.log}`;
    else if (state === "couldnt_run") detail = `couldn't run: ${record.reason}` + (record.log ? `  log: ${record.log}` : "");
    else detail = record.reason ?? "not run";
    return `  ${MARK[state]} ${check.id.padEnd(4)} ${detail}`;
  });
}

// The task's repositories: each one's current tree and head, and which have
// uncommitted changes. Plain git; the gate, commit and hook all use these.
function look(repos: Repos) {
  const trees: Record<string, string> = {};
  const heads: Record<string, string> = {};
  const changed: string[] = [];
  for (const name of repos.names) {
    const root = repos.paths[name];
    trees[name] = snapshot(root);
    heads[name] = headSha(root);
    if (trees[name] !== headTree(root)) changed.push(name);
  }
  return { trees, heads, changed };
}

// "abc123" for one repository, "web abc123, api def456" for several.
function perRepo(repos: Repos, values: Record<string, string>) {
  return repos.multi ? repos.names.map((name) => `${name} ${values[name]}`).join(", ") : values[repos.names[0]];
}

// --- Modes --------------------------------------------------------------------

async function cmdStart() {
  const root = gitRoot();
  const task = tasks.resolve(root);
  const meta = tasks.readMeta(task)!;
  const [, goal] = tasks.loadGoal(task, meta);
  tasks.verifiedConfig(task, meta);
  const state = tasks.readState(task);
  const goalFile = path.join(task, "goal.md");
  const repos = fromPaths(meta.repos);

  if (meta.status === "ready") {
    for (const name of repos.names) requireClean(repos.paths[name], repos.multi ? name : undefined);
    const base = Object.fromEntries(repos.names.map((name) => [name, headSha(repos.paths[name])]));
    meta.status = "active";
    meta.base = base;
    meta.started = now();
    tasks.writeMeta(task, meta);
    state.next = `work on ${goal.objectives[0].id} (not started)`;
    tasks.writeState(task, state);
    const hookNotes = repos.names.map((name) => tasks.installHook(repos.paths[name], CHECK_PATH));
    tasks.event(task, "start", { base, version: meta.goal_version });
    out(`STARTED  ${path.basename(task)}`,
      `Goal:    ${goalFile}  (version ${meta.goal_version})`,
      `Base:    ${perRepo(repos, base)}`,
      ...hookNotes,
      config.handoffLine(),
      "",
      "Objectives:", ...objectiveLines(goal, state.objectives),
      "",
      `NEXT: ${state.next}`);
    return EXIT_PASS;
  }

  const base = meta.base ?? {};
  const lost = repos.names.filter((name) => !reachable(repos.paths[name], base[name] ?? ""));
  const baseNote = lost.length ? `  (base commit no longer reachable: ${lost.join(", ")})` : "";
  const { trees, heads, changed } = look(repos);
  let pending = "";
  if (changed.length) {
    const passed = state.last_pass && repos.names.every((name) => state.last_pass![name] === trees[name]);
    pending = passed ? "passed the gate, not yet committed" : "not yet gated; run check.ts before committing";
  }
  tasks.event(task, "resume", { heads, uncommitted: pending || null });
  out(`RESUMED  ${path.basename(task)}`,
    `Goal:    ${goalFile}  (version ${meta.goal_version})`,
    `Base:    ${perRepo(repos, base)}${baseNote}`,
    config.handoffLine(),
    ...(pending ? [`Uncommitted changes: ${pending}`] : []),
    "",
    "Objectives:", ...objectiveLines(goal, state.objectives ?? {}),
    "Verify:", ...verifyLines(goal, state.verify ?? {}),
    "",
    `NEXT: ${state.next || "run check.ts on your next change"}`);
  return EXIT_PASS;
}

async function cmdGate() {
  const root = gitRoot();
  const [task, meta] = openTask(root);
  const [, goal] = tasks.loadGoal(task, meta);
  tasks.verifiedConfig(task, meta);
  const state = tasks.readState(task);
  const repos = fromPaths(meta.repos);
  const base = meta.base!;

  const { trees, heads, changed } = look(repos);
  const hasChanges = changed.length > 0;
  if (!hasChanges && repos.names.every((name) => heads[name] === base[name])) {
    tasks.event(task, "gate", { result: "escalate", reason: "no-changes" });
    die(EXIT_ESCALATE,
      "ESCALATE: there are no changes to check.",
      "Nothing was committed.",
      `NEXT: ${state.next || "make a change toward the first objective"}, then run check.ts`);
  }

  const record: Record<string, unknown> = { trees, heads, has_changes: hasChanges, version: meta.goal_version };
  let lines: string[] = [];

  if (hasChanges) {
    const paths = changed.flatMap((name) =>
      changedPaths(repos.paths[name], "HEAD", trees[name]).map((p) => qualify(repos, name, p)));
    const uncovered = goalfmt.uncovered(goal, paths);
    if (uncovered.length) {
      return stop(task, state, record,
        ["BLOCKED: files changed that no objective lists.", ...uncovered.map((p) => `  ${p}`)],
        { uncovered });
    }

    const results = await gate.scope(repos, goal, trees, changed);
    const { blocked, tripped, unsure, drift } = gate.judgeScope(results);
    Object.assign(record, { scope: results, drift });
    lines = ["Scope:",
      ...results.map((r) => `  ${r.path}  ${r.verdict} (${fixed(r.confidence)})`),
      ...Object.entries(drift).map(([k, v]) => `  ${k.padEnd(16)} ${fixed(v)}  (max)`)];
    if (blocked.length || Object.keys(tripped).length) {
      Object.assign(record, { blocked, tripped });
      const trippedLine = Object.entries(tripped).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} ${fixed(v)}`).join(", ");
      return stop(task, state, record,
        ["BLOCKED: this change contains work the goal does not ask for.", ...lines,
          ...(trippedLine ? [`Tripped: ${trippedLine}`] : [])],
        { blocked: true });
    }
    if (unsure.length) {
      Object.assign(record, { unsure });
      return stop(task, state, record,
        ["ESCALATE: Jev is not confident enough to gate this automatically.", ...lines,
          "Nothing was committed. The user decides."],
        { unsure });
    }
  }

  const objectives = await gate.completion(repos, goal, base, trees, state.objectives ?? {});
  let checks: Record<string, Record_>;
  if (Object.values(objectives).every((r) => r.state === "met")) {
    checks = await gate.runVerify(repos, goal, trees, state.verify ?? {}, path.join(task, "verify"));
    const after = look(repos).trees;
    // The gate checked `trees`; committing `after` would commit files nobody checked.
    const changedByVerify = repos.names.flatMap((name) => after[name] === trees[name] ? []
      : changedPaths(repos.paths[name], trees[name], after[name]).map((p) => qualify(repos, name, p)));
    if (changedByVerify.length) {
      Object.assign(record, { objectives, verify: checks, verify_changed: changedByVerify });
      return stop(task, state, record,
        ["ESCALATE: the Verify commands changed files in the repository.",
          ...changedByVerify.map((p) => `  ${p}`),
          "Nothing was committed. The user decides."],
        { verifyChanged: changedByVerify });
    }
  } else {
    checks = gate.waitingVerify(goal);
  }
  const [code, nextLine, complete] = routing.decide({
    objectives: goal.objectives.map((o) => [o.id, objectives[o.id]]),
    verify: goal.verify.map((c) => [c.id, checks[c.id]]),
    hasChanges,
  });

  Object.assign(state, {
    objectives, verify: checks, next: nextLine,
    last_pass: hasChanges ? trees : null,
    last_pass_complete: complete && hasChanges,
  });
  tasks.writeState(task, state);
  Object.assign(record, { result: "pass", objectives, verify: checks, complete, next: nextLine, exit: code });
  tasks.event(task, "gate", record);
  if (complete && !hasChanges) {
    meta.status = "complete";
    meta.closed = now();
    tasks.writeMeta(task, meta);
    tasks.event(task, "complete", { heads });
  }

  const met = Object.values(objectives).filter((r) => r.state === "met").length;
  out(hasChanges ? "PASS: this change is within the recorded goal."
    : `NO NEW CHANGES: checked the committed work at ${perRepo(repos, heads)}.`,
  ...lines,
  "",
  `Objectives (${met}/${goal.objectives.length} met):`, ...objectiveLines(goal, objectives),
  "Verify:", ...verifyLines(goal, checks),
  "",
  complete && !hasChanges ? "GOAL COMPLETE. The task is closed."
    : complete ? "GOAL COMPLETE once committed." : "GOAL NOT YET COMPLETE.",
  ...(hasChanges ? ['Commit it with: check.ts --commit -m "<message>"'] : []),
  `NEXT: ${nextLine}`);
  return code;
}

// A blocked or escalated gate: nothing passes, and NEXT goes to the user.
function stop(
  task: string,
  state: State,
  record: Record<string, unknown>,
  lines: string[],
  why: { uncovered?: string[]; blocked?: boolean; unsure?: string[]; verifyChanged?: string[] },
) {
  const [code, nextLine] = routing.decide(why);
  Object.assign(state, { last_pass: null, last_pass_complete: false, next: nextLine });
  tasks.writeState(task, state);
  Object.assign(record, {
    result: code === EXIT_BLOCK ? "block" : "escalate", next: nextLine, exit: code,
    ...(why.uncovered ? { uncovered: why.uncovered } : {}),
  });
  tasks.event(task, "gate", record);
  if (code === EXIT_BLOCK) {
    lines.push("", "Do not revert on your own. Show this to the user and ask.",
      `If they approve, revert with: ${routing.REVERT}`, "(Recoverable: git stash pop.)");
  }
  out(...lines, `Goal: ${path.join(task, "goal.md")}`, `NEXT: ${nextLine}`);
  return code;
}

const BAD_PREFIX = /^\s*(claude|codex|gpt|chatgpt|copilot|cursor|ai|bot|agent|assistant)\b[\s:>\-–—]+/i;
const BAD_TRAILER = /^\s*(co-authored-by\s*:|generated with|created by (claude|codex|an? ai))/i;
const CONVENTIONAL = /^\w+(\([^)]*\))?!?: /;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}✅❌]/gu;
const HAS_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}✅❌]/u;

// Message format is a fact, so it is enforced here rather than trusted.
export function sanitizeMessage(message: string, allowConventional: boolean): [string, string[]] {
  const lines = message.trim().split("\n");
  const kept = lines.filter((line) => !BAD_TRAILER.test(line));
  let subject = kept.length ? kept[0].trim() : "";

  let previous: string | null = null;
  while (subject !== previous) {
    previous = subject;
    subject = subject.replace(BAD_PREFIX, "").trim();
  }
  subject = subject.replace(EMOJI, "").trim();

  if (!allowConventional) subject = subject.replace(CONVENTIONAL, "").trim();

  subject = subject.replace(/\s+/g, " ").replace(/\.+$/, "").trim();
  if (subject && subject[0] !== subject[0].toUpperCase() && !CONVENTIONAL.test(subject)) {
    subject = subject[0].toUpperCase() + subject.slice(1);
  }
  const limit = num("commits.max_subject_chars");
  if (subject.length > limit) {
    const cut = subject.slice(0, limit);
    const space = cut.lastIndexOf(" ");
    subject = (space === -1 ? cut : cut.slice(0, space)).replace(/[,;:-]+$/, "");
  }

  const body = kept.slice(1).filter((line) => !HAS_EMOJI.test(line));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1)!.trim()) body.pop();
  return [subject, body];
}

async function cmdCommit(message: string) {
  const root = gitRoot();
  const [task, meta] = openTask(root);
  tasks.loadGoal(task, meta);
  const state = tasks.readState(task);
  const repos = fromPaths(meta.repos);

  const { trees, changed } = look(repos);
  if (!changed.length) die(EXIT_ESCALATE, "ESCALATE: there is nothing to commit.");
  if (!state.last_pass || repos.names.some((name) => state.last_pass![name] !== trees[name])) {
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: no passing gate for the current changes.",
      "Run check.ts with no arguments and act on its exit code.",
      "Nothing was committed.");
  }

  const [subject, body] = sanitizeMessage(message, usesConventionalCommits(root));
  if (!subject) {
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: nothing usable left in the commit message.",
      "Write a short, plain subject line describing the change.");
  }

  // Stage every repository and confirm each matches what passed before committing any.
  for (const name of changed) {
    git(repos.paths[name], ["add", "-A"], { check: true });
    const [, staged] = git(repos.paths[name], ["write-tree"], { check: true });
    if (staged.trim() !== trees[name]) {
      die(EXIT_ESCALATE, "ESCALATE: the files changed while committing. Nothing was committed.", "Run check.ts again.");
    }
  }
  const full = body.length ? `${subject}\n\n${body.join("\n")}` : subject;
  const shas: Record<string, string> = {};
  for (const name of changed) {
    const [rc] = git(repos.paths[name], ["commit", "-m", full], { env: { ...process.env, [COMMIT_ENV]: trees[name] } });
    if (rc !== 0) {
      if (Object.keys(shas).length) tasks.event(task, "commit", { shas, subject, trees, failed: name });
      die(EXIT_ESCALATE, `ESCALATE: git commit failed in ${name}.`,
        Object.keys(shas).length
          ? `Already committed: ${Object.entries(shas).map(([n, sha]) => `${n} ${sha}`).join(", ")}`
          : "Nothing was committed.");
    }
    shas[name] = headSha(repos.paths[name]);
  }

  const complete = state.last_pass_complete ?? false;
  state.last_pass = null;
  state.last_pass_complete = false;
  tasks.writeState(task, state);
  tasks.event(task, "commit", { shas, subject, trees });
  if (repos.multi) out(`COMMITTED  ${subject}`, ...changed.map((name) => `  ${name}  ${shas[name]}`));
  else out(`COMMITTED  ${shas[changed[0]]}  ${subject}`);
  const firstLine = message.trim().split("\n")[0].trim();
  if (subject !== firstLine) out(`(message normalized from: ${firstLine})`);
  if (complete) {
    const heads = Object.fromEntries(repos.names.map((name) => [name, headSha(repos.paths[name])]));
    meta.status = "complete";
    meta.closed = now();
    tasks.writeMeta(task, meta);
    tasks.event(task, "complete", { heads });
    out("GOAL COMPLETE. The task is closed.",
      ...repos.names.map((name) => `Task diff: git -C ${repos.paths[name]} diff ${meta.base![name]}..HEAD`));
  } else {
    out(`NEXT: ${state.next}`);
  }
  out("Not pushed. This skill never pushes.");
  return EXIT_PASS;
}

// Record config values the user changed mid-task. Only on the user's say-so.
async function cmdAcceptConfig() {
  const root = gitRoot();
  const task = tasks.resolve(root);
  const meta = tasks.readMeta(task)!;
  if (meta.config_hash === config.configHash()) {
    out("The config has not changed. Nothing to accept.");
    return EXIT_PASS;
  }
  const changes = config.changes(meta.config ?? {});
  meta.config_hash = config.configHash();
  meta.config = tasks.snapshotConfig();
  tasks.writeMeta(task, meta);
  const state = tasks.readState(task);
  state.last_pass = null;
  state.last_pass_complete = false;
  tasks.writeState(task, state);
  tasks.event(task, "config-accept", { changes });
  out("ACCEPTED: the new config is recorded for this task.", ...changes,
    "Any earlier pass is void. Run check.ts before committing.");
  return EXIT_PASS;
}

async function cmdClose() {
  const root = gitRoot();
  const task = tasks.resolve(root);
  const meta = tasks.readMeta(task)!;
  meta.status = "closed";
  meta.closed = now();
  tasks.writeMeta(task, meta);
  const state = tasks.readState(task);
  state.last_pass = null;
  state.last_pass_complete = false;
  tasks.writeState(task, state);
  tasks.event(task, "close", { detail: "closed incomplete" });
  out(`CLOSED  ${meta.id}`, "Uncommitted changes, if any, were left as they are.");
  return EXIT_PASS;
}

// pre-commit: while a task is active, only --commit may commit, and only the gated tree.
async function cmdHook() {
  const root = gitRoot();
  const matches = tasks.find(root, ["active"]);
  if (!matches.length) return EXIT_PASS;
  const meta = matches.length === 1 ? tasks.readMeta(matches[0]) : null;
  const name = Object.entries(meta?.repos ?? {}).find(([, p]) => p === root)?.[0];
  const passed = meta && name ? tasks.readState(matches[0]).last_pass?.[name] : undefined;
  const [rc, staged] = git(root, ["write-tree"]);
  const tree = staged.trim();
  if (rc === 0 && tree && tree === passed && tree === process.env[COMMIT_ENV]) return EXIT_PASS;
  out("task-contract: commit rejected. It did not pass the gate.",
    `Active task: ${matches.map((m) => path.basename(m)).join(", ")}`,
    "Run check.ts, then check.ts --commit. To stop the task: check.ts --close.");
  return EXIT_BLOCK;
}

const USAGE = "usage: check.ts [--start | --commit -m <message> | --accept-config | --close | --hook] [--session <id>]";

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        start: { type: "boolean" },
        commit: { type: "boolean" },
        "accept-config": { type: "boolean" },
        close: { type: "boolean" },
        hook: { type: "boolean" },
        message: { type: "string", short: "m", default: "" },
        session: { type: "string", default: "" },
      },
    }));
  } catch (err) {
    die(2, USAGE, err instanceof Error ? err.message : String(err));
  }
  const modes = (["start", "commit", "accept-config", "close", "hook"] as const).filter((m) => values[m]);
  if (modes.length > 1) die(2, USAGE, `only one of --${modes.join(", --")}`);
  jev.session.id = values.session!;
  if (values.hook) return cmdHook();
  config.load();
  if (values.start) return cmdStart();
  if (values.commit) {
    if (!values.message!.trim()) die(EXIT_PRECONDITION, "PRECONDITION FAILED: --commit requires -m <message>.");
    return cmdCommit(values.message!);
  }
  if (values["accept-config"]) return cmdAcceptConfig();
  if (values.close) return cmdClose();
  return cmdGate();
}

if (import.meta.main) await run(main);
