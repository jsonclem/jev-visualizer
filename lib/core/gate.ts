// One gate: coverage (plain code), scope (Jev), completion per objective (Jev),
// Verify (exit codes). Returns facts; routing.decide turns them into NEXT.

import { EXIT_ESCALATE, die, now, textHash } from "./common.ts";
import { num } from "./config.ts";
import { changedPaths, diff, splitFiles } from "./gitutil.ts";
import * as goalfmt from "./goalfmt.ts";
import type { Goal } from "./goalfmt.ts";
import { qualify, type Repos } from "./repos.ts";
import * as jev from "./jev.ts";
import type { Questions } from "./jev.ts";
import type { Record_ } from "./tasks.ts";
import { runCheck } from "./verify.ts";

export const DRIFT_KEYS = ["drift_refactor", "drift_deps", "drift_tests_docs", "drift_behavior", "drift_substitute"];

export type ScopeResult = {
  path: string;
  verdict: string;
  confidence: number;
  drift: Record<string, number>;
  parts: number;
};

// Asked once per changed file, or per group of hunks when a file is large.
export function scopeQuestions(): Questions {
  return {
    verdict: {
      type: "choice",
      instructions:
        "Does `diff` make only changes that `objectives` ask for, while keeping " +
        "to `rules` and leaving `out_of_scope` alone? `diff` is one step of the " +
        "work: leaving part of `objectives` unfinished is not a scope problem.",
      criteria: {
        within_scope: {
          what: "Every change in `diff` is required by `objectives`, even if some are not finished yet",
          not_for: "Changes that are merely adjacent, tidy, or beneficial",
        },
        outside_scope: {
          what: "`diff` contains at least one change `objectives` do not ask for, " +
            "or breaks `rules`, or touches `out_of_scope`",
          examples: ["Renaming an unrelated symbol", "Adding a dependency not requested"],
        },
      },
    },
    drift_refactor: {
      type: "noul",
      instructions:
        "Does `diff` contain cleanup, refactoring, renaming, or restructuring that `objectives` do not ask for?",
    },
    drift_deps: {
      type: "noul",
      instructions: "Does `diff` add a dependency that `objectives` do not ask for?",
    },
    drift_tests_docs: {
      type: "noul",
      instructions: "Does `diff` add tests, documentation, or comments that `objectives` do not ask for?",
    },
    drift_behavior: {
      type: "noul",
      instructions:
        "Does `diff` change behavior beyond what `objectives` ask for? Behavior " +
        "that `objectives` ask for but `diff` has not finished yet does not count.",
    },
    drift_substitute: {
      type: "noul",
      instructions: "Does `diff` substitute a related improvement for the result `objectives` ask for?",
    },
  };
}

export function completionQuestions(): Questions {
  return {
    met: {
      type: "noul",
      instructions:
        "Does `diff` fully implement `objective`? `diff` is the whole change since " +
        "the task began, limited to the files `objective` lists.",
    },
  };
}

// Split one file's diff into requests that fit. null if one hunk cannot.
export function chunks(state: Record<string, unknown>, fileDiff: string, questions: Questions) {
  if (jev.fits({ ...state, diff: fileDiff }, questions)) return [fileDiff];
  const parts = fileDiff.split(/^(?=@@)/m);
  const header = parts[0];
  const hunks = parts.slice(1);
  const groups: string[] = [];
  let current = header;
  for (const hunk of hunks) {
    const candidate = current + hunk;
    if (jev.fits({ ...state, diff: candidate }, questions)) {
      current = candidate;
      continue;
    }
    if (current === header) return null;
    groups.push(current);
    current = header + hunk;
    if (!jev.fits({ ...state, diff: current }, questions)) return null;
  }
  groups.push(current);
  return groups;
}

// Per changed file since HEAD, in every repository with changes:
// [{path, verdict, confidence, drift{...}}].
//
// Jev sees only the objectives that list the file, plus every rule and
// out-of-scope item: a smaller request, and the part of the goal that applies.
export async function scope(repos: Repos, goal: Goal, trees: Record<string, string>, changed: string[]) {
  const questions = scopeQuestions();
  const rules = goal.rules.map((r) => `${r.id}: ${r.text}`);
  const outOfScope = goal.out_of_scope.map((x) => `${x.id}: ${x.text}`);
  const files: [string, string][] = [];
  for (const name of changed) {
    const text = diff(repos.paths[name], "HEAD", trees[name],
      { context: num("diff.scope_context_lines"), prefix: repos.multi ? name : undefined });
    if (text === null) die(EXIT_ESCALATE, `ESCALATE: could not diff ${name} against HEAD.`);
    files.push(...splitFiles(text));
  }
  const results: ScopeResult[] = [];
  for (const [path, fileDiff] of files) {
    const state = {
      objectives: goalfmt.owners(goal, path).map(goalfmt.render),
      rules,
      out_of_scope: outOfScope,
      file: path,
    };
    const parts = chunks(state, fileDiff, questions);
    if (parts === null) {
      die(EXIT_ESCALATE,
        `ESCALATE: a change in ${path} is too large to check in one request.`,
        "It was NOT checked and NOT truncated. Nothing was committed.",
        "NEXT: ask the user: the change is too large for Jev; they decide how to split it.");
    }
    let worst: ScopeResult | null = null;
    for (const [n, part] of parts.entries()) {
      const answers = await jev.ask({ ...state, diff: part }, questions, "scope",
        { file: path, part: `${n + 1}/${parts.length}`, trees });
      const result: ScopeResult = {
        path,
        verdict: answers.verdict.choice as string,
        confidence: answers.verdict.confidence as number,
        drift: Object.fromEntries(DRIFT_KEYS.map((k) => [k, answers[k].noul as number])),
        parts: parts.length,
      };
      worst = worst === null ? result : worse(worst, result);
    }
    results.push(worst!);
  }
  return results;
}

// The part that decides the gate: the most confident outside_scope, else the least confident.
export function worse(a: ScopeResult, b: ScopeResult): ScopeResult {
  const drift = Object.fromEntries(DRIFT_KEYS.map((k) => [k, Math.max(a.drift[k], b.drift[k])]));
  const aOut = a.verdict === "outside_scope";
  const bOut = b.verdict === "outside_scope";
  let pick: ScopeResult;
  if (aOut !== bOut) pick = aOut ? a : b;
  else if (aOut) pick = a.confidence >= b.confidence ? a : b;
  else pick = a.confidence <= b.confidence ? a : b;
  return { ...pick, drift };
}

// [blocked files, tripped drifts, unsure files, max drift] from scope results.
export function judgeScope(results: ScopeResult[]) {
  const drift = Object.fromEntries(DRIFT_KEYS.map((k) => [k, Math.max(0, ...results.map((r) => r.drift[k]))]));
  const blocked = results
    .filter((r) => r.verdict === "outside_scope" && r.confidence >= num("scope.block_verdict_confidence"))
    .map((r) => r.path);
  const unsure = results
    .filter((r) => !blocked.includes(r.path) && r.confidence < num("scope.min_verdict_confidence"))
    .map((r) => r.path);
  const tripped = Object.fromEntries(Object.entries(drift).filter(([, v]) => v >= num("scope.drift_block")));
  return { blocked, tripped, unsure, drift };
}

// {id: record} for every objective, against the whole change since the task began.
//
// Each objective sees only its own files, across every repository, with whole
// enclosing functions when they fit and a few lines of context when they do
// not. A record is reused while the objective's text and its diff are unchanged.
export async function completion(
  repos: Repos,
  goal: Goal,
  base: Record<string, string>,
  trees: Record<string, string>,
  previous: Record<string, Record_>,
) {
  const changed = repos.names.flatMap((name) =>
    changedPaths(repos.paths[name], base[name], trees[name]).map((p) => [name, p, qualify(repos, name, p)]));
  const questions = completionQuestions();
  const records: Record<string, Record_> = {};

  // The objective's files, across repositories, as one diff. null if git fails.
  const diffOf = (matched: string[][], options: { context?: number; functionContext?: boolean }) => {
    const parts: string[] = [];
    for (const name of repos.names) {
      const inRepo = matched.filter(([repo]) => repo === name).map(([, p]) => p);
      if (!inRepo.length) continue;
      const text = diff(repos.paths[name], base[name], trees[name],
        { ...options, paths: inRepo, prefix: repos.multi ? name : undefined });
      if (text === null) return null;
      parts.push(text);
    }
    return parts.join("");
  };

  for (const objective of goal.objectives) {
    const matched = changed.filter(([, , q]) => objective.files.some((f) => goalfmt.matches(f, q)));
    const files = matched.map(([, , q]) => q);
    if (!files.length) {
      records[objective.id] = { state: "pending", reason: "no changes in its files yet", files: [] };
      continue;
    }
    const state = { objective: goalfmt.render(objective) };
    let text = diffOf(matched, { functionContext: true });
    let mode = "function";
    if (text !== null && !jev.fits({ ...state, diff: text }, questions)) {
      text = diffOf(matched, { context: num("diff.completion_fallback_lines") });
      mode = `U${num("diff.completion_fallback_lines")}`;
    }
    if (text === null) die(EXIT_ESCALATE, `ESCALATE: could not diff ${objective.id}'s files.`);
    const key = textHash(goalfmt.render(objective) + "\n" + text);
    const old = previous[objective.id] ?? {};
    if (old.key === key && ["met", "not_met", "unchecked"].includes(old.state)) {
      records[objective.id] = old;
      continue;
    }
    const tokens = jev.requestTokens({ ...state, diff: text }, questions);
    if (tokens > jev.budget()) {
      records[objective.id] = {
        state: "unchecked", key, files, at: now(),
        reason: `too large: about ${tokens} tokens, limit ${Math.trunc(jev.budget())}`,
      };
      continue;
    }
    const answers = await jev.ask({ ...state, diff: text }, questions, "completion",
      { id: objective.id, base, trees, files, diff: mode });
    const score = answers.met.noul as number;
    records[objective.id] = {
      state: score >= num("completion.item_complete") ? "met" : "not_met",
      score, key, files, diff: mode, at: now(),
    };
  }
  return records;
}

// {id: record}. Runs only when every objective is met, each command in its own
// repository; a pass is reused while that repository's tree is the same.
export async function runVerify(
  repos: Repos,
  goal: Goal,
  trees: Record<string, string>,
  previous: Record<string, Record_>,
  logDir: string,
) {
  const records: Record<string, Record_> = {};
  for (const check of goal.verify) {
    const name = check.repo || repos.names[0];
    const tree = trees[name];
    const old = previous[check.id] ?? {};
    if (old.state === "passed" && old.tree === tree && old.command === check.command) {
      records[check.id] = old;
      continue;
    }
    const result = await runCheck(check, repos.paths[name], logDir,
      num("verify.timeout_seconds"), num("verify.requires_timeout_seconds"));
    records[check.id] = { ...result, repo: name, tree, at: now() };
  }
  return records;
}

export function waitingVerify(goal: Goal): Record<string, Record_> {
  return Object.fromEntries(goal.verify.map((c) => [c.id, { state: "pending", reason: "waits for every objective to be met" }]));
}
