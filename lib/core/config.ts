// config.json: every tunable, validated. Invalid config never falls back.

import { readFileSync } from "node:fs";
import { EXIT_PRECONDITION, die, paths, pyDumps, sortKeys, textHash } from "./common.ts";

type Kind = "str" | "int" | "float";

// Each config path, its type and allowed range.
const SCHEMA: [string, Kind, number?, number?][] = [
  ["model", "str"],
  ["goal_clarity.min_precision_score", "float", 0, 3],
  ["goal_clarity.min_boundedness_score", "float", 0, 3],
  ["goal_clarity.min_confidence", "float", 0, 1],
  ["goal_clarity.drift_license_block", "float", 0, 1],
  ["objective_clarity.multiple_conditions_block", "float", 0, 1],
  ["objective_clarity.not_checkable_block", "float", 0, 1],
  ["objective_clarity.vague_block", "float", 0, 1],
  ["objective_clarity.rule_is_objective_block", "float", 0, 1],
  ["scope.block_verdict_confidence", "float", 0, 1],
  ["scope.drift_block", "float", 0, 1],
  ["scope.min_verdict_confidence", "float", 0, 1],
  ["completion.item_complete", "float", 0, 1],
  ["diff.scope_context_lines", "int", 0, 50],
  ["diff.completion_fallback_lines", "int", 0, 50],
  ["verify.timeout_seconds", "int", 1, 7200],
  ["verify.requires_timeout_seconds", "int", 1, 600],
  ["request_budget.max_tokens", "int", 1000, 32000],
  ["request_budget.headroom", "float", 0.1, 1],
  ["request_budget.chars_per_token", "float", 1, 6],
  ["commits.max_subject_chars", "int", 20, 200],
  ["handoff.context_percent", "int", 10, 95],
];

export type Config = Record<string, number | string>;

// Flat {"scope.drift_block": 0.6, ...} once loaded.
export const CFG: Config = {};

export function num(key: string): number {
  return CFG[key] as number;
}

export function load() {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.config, "utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) die(EXIT_PRECONDITION, `PRECONDITION FAILED: ${paths.config} is not valid JSON (${err.message}).`);
    die(EXIT_PRECONDITION, `PRECONDITION FAILED: cannot read ${paths.config}.`);
  }
  loadObject(raw);
}

export function loadObject(raw: unknown) {
  const problems: string[] = [];
  const known = new Set(SCHEMA.map(([label]) => label));

  const unknown = (node: Record<string, unknown>, prefix: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("_")) continue;
      const path = [...prefix, key];
      if (value && typeof value === "object" && !Array.isArray(value)) unknown(value as Record<string, unknown>, path);
      else if (!known.has(path.join("."))) problems.push(`unknown setting ${path.join(".")}`);
    }
  };

  let root = raw as Record<string, unknown>;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    root = {};
    problems.push("the top level must be an object");
  }
  unknown(root, []);

  const flat: Config = {};
  for (const [label, kind, low, high] of SCHEMA) {
    let node: unknown = root;
    for (const key of label.split(".")) {
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
    }
    if (kind === "str") {
      if (typeof node !== "string" || !node.trim()) {
        problems.push(`${label} is missing or empty`);
        continue;
      }
      flat[label] = node;
      continue;
    }
    if (typeof node !== "number" || !Number.isFinite(node)) {
      problems.push(`${label} is missing or not a number`);
      continue;
    }
    if (kind === "int" && !Number.isInteger(node)) {
      problems.push(`${label} must be a whole number`);
      continue;
    }
    if (low !== undefined && high !== undefined && !(low <= node && node <= high)) {
      problems.push(`${label} = ${node} is outside ${low} to ${high}`);
      continue;
    }
    flat[label] = node;
  }

  if (problems.length) {
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: config.json is invalid. Nothing was checked.",
      ...problems.map((p) => `  - ${p}`),
      `Config: ${paths.config}`);
  }
  for (const key of Object.keys(CFG)) delete CFG[key];
  Object.assign(CFG, flat);
}

// Hash of the effective values only, so editing a note is not a change.
export function configHash() {
  return textHash(pyDumps(sortKeys(CFG)));
}

export function changes(old: Config) {
  return Object.entries(CFG)
    .filter(([key, value]) => old[key] !== value)
    .map(([key, value]) => `  ${key}: ${key in old ? old[key] : "(unset)"} -> ${value}`);
}

export function handoffLine() {
  return `Handoff: at about ${CFG["handoff.context_percent"]}% context use, ` +
    "only when reliable usage information is available.";
}
