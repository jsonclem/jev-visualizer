/*
The goal format. Parsing and structure checks are plain code, never Jev.

    # <title>
    Repo: <repository folder name>
    <optional summary lines>

    ## Objectives
    ### O1 <optional short title>
    Files: <path or pattern>, <path or pattern>
    <what must be true when it is done>

    ## Rules
    - R1: <a limit on how the work is done>

    ## Out of scope
    - X1: <something not to change>

    ## Verify
    - V1: <shell command; exit 0 means pass>
      Requires: <optional shell command; nonzero means V1 couldn't run>

Objectives and Verify are required; Rules and Out of scope are optional.
Sections appear in this order, each at most once.
*/

import { capitalize, splitLines } from "./common.ts";

const SECTIONS = ["objectives", "rules", "out of scope", "verify"] as const;
type Section = (typeof SECTIONS)[number];
const PREFIX: Record<Section, string> = { objectives: "O", rules: "R", "out of scope": "X", verify: "V" };
const TITLE = /^# (.*\S)\s*$/;
const REPO = /^Repo:\s*(.*?)\s*$/;
const SECTION = /^## (.*\S)\s*$/;
const OBJECTIVE = /^### (\S+)(?:\s+(.*\S))?\s*$/;
const ITEM = /^[-*]\s+(\S+?):\s*(.*?)\s*$/;
const FILES = /^Files:\s*(.*?)\s*$/;
const REQUIRES = /^Requires:\s*(.*?)\s*$/;
const ID = /^([A-Z])([1-9]\d*)$/;

export type Objective = { id: string; title: string; files: string[]; text: string };
export type Item = { id: string; text: string };
export type Check = { id: string; command: string; requires: string };
export type Goal = {
  title: string;
  repo: string;
  summary: string;
  objectives: Objective[];
  rules: Item[];
  out_of_scope: Item[];
  verify: Check[];
};

export function emptyGoal(): Goal {
  return { title: "", repo: "", summary: "", objectives: [], rules: [], out_of_scope: [], verify: [] };
}

// The objective as Jev reads it, and as versions are compared.
export function render(objective: Objective) {
  const head = objective.title ? `${objective.id}: ${objective.title}` : objective.id;
  return `${head}\nFiles: ${objective.files.join(", ")}\n${objective.text}`;
}

export function ids(goal: Goal) {
  return [...goal.objectives, ...goal.rules, ...goal.out_of_scope, ...goal.verify].map((x) => x.id);
}

// The order goal.json is written in.
export function toDict(goal: Goal) {
  return {
    title: goal.title,
    repo: goal.repo,
    summary: goal.summary,
    objectives: goal.objectives.map((o) => ({ id: o.id, title: o.title, files: o.files, text: o.text })),
    rules: goal.rules.map((i) => ({ id: i.id, text: i.text })),
    out_of_scope: goal.out_of_scope.map((i) => ({ id: i.id, text: i.text })),
    verify: goal.verify.map((c) => ({ id: c.id, command: c.command, requires: c.requires })),
  };
}

export function unquote(text: string) {
  text = text.trim();
  if (text.length >= 2 && text[0] === "`" && text.at(-1) === "`") return text.slice(1, -1).trim();
  return text;
}

// [goal, errors]. Errors name the line, so the fix is obvious.
export function parse(text: string): [Goal, string[]] {
  const goal = emptyGoal();
  const errors: string[] = [];
  const summary: string[] = [];
  let section: Section | "unknown" | null = null;
  const seen: Section[] = [];
  let current: (Objective & { kind: "objective" }) | (Item & { kind: "item" }) | (Check & { kind: "check" }) | null = null;
  let body: string[] = [];

  const closeObjective = () => {
    if (current?.kind === "objective") {
      current.text = body.join("\n").trim();
      if (!current.text) errors.push(`${current.id}: says nothing after its Files: line.`);
    }
    current = null;
    body = [];
  };

  const checkId = (raw: string, where: Section, n: number) => {
    const prefix = PREFIX[where];
    const match = ID.exec(raw);
    if (!match || match[1] !== prefix) {
      errors.push(`line ${n}: '${raw}' is not a valid ID here; ${capitalize(where)} use ${prefix}1, ${prefix}2, ...`);
      return false;
    }
    return true;
  };

  splitLines(text).forEach((raw, index) => {
    const n = index + 1;
    const line = raw.trimEnd();
    let match: RegExpExecArray | null;

    if (!goal.title && line.trim()) {
      match = TITLE.exec(line);
      if (match) {
        goal.title = match[1];
        return;
      }
      errors.push(`line ${n}: the goal must start with '# <title>'.`);
      goal.title = "(missing)";
    }

    if (TITLE.test(line)) {
      errors.push(`line ${n}: only one '# ' title is allowed.`);
      return;
    }

    match = SECTION.exec(line);
    if (match) {
      closeObjective();
      const name = match[1].trim().toLowerCase() as Section;
      if (!SECTIONS.includes(name)) {
        errors.push(`line ${n}: unknown section '## ${match[1]}'. Allowed: Objectives, Rules, Out of scope, Verify.`);
        section = "unknown";
        return;
      }
      if (seen.includes(name)) {
        errors.push(`line ${n}: '## ${match[1]}' appears twice.`);
      } else if (seen.length && SECTIONS.indexOf(name) < SECTIONS.indexOf(seen.at(-1)!)) {
        errors.push(`line ${n}: '## ${match[1]}' is out of order. Order: Objectives, Rules, Out of scope, Verify.`);
      }
      seen.push(name);
      section = name;
      return;
    }

    if (section === null) {
      match = REPO.exec(line);
      if (match) {
        if (goal.repo) errors.push(`line ${n}: 'Repo:' appears twice.`);
        goal.repo = match[1];
      } else if (line.trim()) {
        summary.push(line.trim());
      }
      return;
    }

    if (section === "unknown") return;

    if (section === "objectives") {
      match = OBJECTIVE.exec(line);
      if (match) {
        closeObjective();
        if (checkId(match[1], section, n)) {
          current = { kind: "objective", id: match[1], title: match[2] ?? "", files: [], text: "" };
          goal.objectives.push(current);
        } else {
          current = { kind: "objective", id: "?", title: "", files: [], text: "" };
        }
        return;
      }
      if (line.startsWith("###")) {
        errors.push(`line ${n}: objectives start with '### O<number>'.`);
        return;
      }
      if (current === null) {
        if (line.trim()) {
          errors.push(`line ${n}: text in Objectives outside an objective. Start each objective with '### O<number>'.`);
        }
        return;
      }
      const objective = current as Objective & { kind: "objective" };
      if (!objective.files.length && !body.length) {
        if (!line.trim()) return;
        const files = FILES.exec(line.trim());
        if (!files) {
          errors.push(`${objective.id}: the first line must be 'Files: <paths>'.`);
          objective.files = ["(missing)"];
          body.push(line);
          return;
        }
        objective.files = files[1].split(",").filter((f) => f.trim()).map(unquote);
        if (!objective.files.length) {
          errors.push(`${objective.id}: 'Files:' lists no files.`);
          objective.files = ["(missing)"];
        }
        for (const pattern of objective.files) {
          const problem = badPattern(pattern);
          if (problem) errors.push(`${objective.id}: file '${pattern}' ${problem}.`);
        }
        return;
      }
      body.push(line);
      return;
    }

    // Rules, Out of scope, Verify: bulleted items with IDs.
    if (!line.trim()) return;
    if (line.startsWith("#")) {
      errors.push(`line ${n}: headings are not allowed inside ${capitalize(section)}.`);
      return;
    }
    match = ITEM.exec(line);
    if (match) {
      if (!checkId(match[1], section, n)) {
        current = null;
        return;
      }
      if (section === "verify") {
        const check = { kind: "check" as const, id: match[1], command: unquote(match[2]), requires: "" };
        current = check;
        goal.verify.push(check);
        if (!check.command) errors.push(`${check.id}: has no command.`);
      } else {
        const item = { kind: "item" as const, id: match[1], text: match[2] };
        current = item;
        (section === "rules" ? goal.rules : goal.out_of_scope).push(item);
      }
      return;
    }
    if ((raw[0] === " " || raw[0] === "\t") && current !== null) {
      const open = current as (Item & { kind: "item" }) | (Check & { kind: "check" });
      if (open.kind === "check") {
        const requires = REQUIRES.exec(line.trim());
        if (requires && !open.requires) open.requires = unquote(requires[1]);
        else errors.push(`${open.id}: only one indented 'Requires: <command>' line may follow a Verify command.`);
      } else {
        open.text = `${open.text} ${line.trim()}`.trim();
      }
      return;
    }
    errors.push(`line ${n}: ${capitalize(section)} holds only '- ${PREFIX[section]}<number>: ...' items.`);
  });

  closeObjective();
  goal.summary = summary.join("\n");

  if (!goal.title) errors.push("the goal is empty.");
  if (!goal.repo) errors.push("missing 'Repo: <repository folder name>' under the title.");
  if (!goal.objectives.length) errors.push("no objectives. Add '## Objectives' with at least one '### O1'.");
  if (!goal.verify.length) errors.push("no Verify commands. Add '## Verify' with at least one '- V1: <command>'.");
  for (const item of [...goal.rules, ...goal.out_of_scope]) {
    if (!item.text) errors.push(`${item.id}: is empty.`);
  }
  const seenIds = new Set<string>();
  for (const id of ids(goal)) {
    if (seenIds.has(id)) errors.push(`${id}: used more than once.`);
    seenIds.add(id);
  }
  return [strip(goal), errors];
}

// Drop the parser's bookkeeping so a Goal is plain data.
function strip(goal: Goal): Goal {
  return fromDict(toDict(goal));
}

export function badPattern(pattern: string) {
  if (pattern.startsWith("/")) return "must be relative to the repository root";
  if (pattern.split("/").includes("..")) return "must not contain '..'";
  return null;
}

const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// Patterns: '*' within one folder, '**' across folders, '?' one character.
// A pattern with no wildcard also matches everything under it as a folder.
export function globRegex(pattern: string) {
  if (pattern.endsWith("/")) pattern += "**";
  const out: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out.push("(?:.*/)?");
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out.push(".*");
      i += 2;
    } else if (pattern[i] === "*") {
      out.push("[^/]*");
      i += 1;
    } else if (pattern[i] === "?") {
      out.push("[^/]");
      i += 1;
    } else {
      out.push(escape(pattern[i]));
      i += 1;
    }
  }
  if (!/[*?]/.test(pattern)) out.push("(?:/.*)?");
  return new RegExp("^" + out.join("") + "$");
}

export function matches(pattern: string, path: string) {
  return globRegex(pattern).test(path);
}

// Objectives whose Files cover `path`.
export function owners(goal: Goal, path: string) {
  return goal.objectives.filter((o) => o.files.some((p) => matches(p, path)));
}

export function uncovered(goal: Goal, paths: string[]) {
  return paths.filter((p) => !owners(goal, p).length);
}

// What changed between two goal versions, by ID.
export function compare(old: Goal, next: Goal) {
  const changes: string[] = [];
  for (const [label, a, b] of [
    ["title", old.title, next.title],
    ["Repo", old.repo, next.repo],
    ["summary", old.summary, next.summary],
  ]) {
    if (a !== b) changes.push(`${label} changed`);
  }

  const keyed = (goal: Goal) =>
    new Map<string, string>([
      ...goal.objectives.map((o) => [o.id, render(o)] as [string, string]),
      ...[...goal.rules, ...goal.out_of_scope].map((i) => [i.id, i.text] as [string, string]),
      ...goal.verify.map((c) => [c.id, `${c.command}\n${c.requires}`] as [string, string]),
    ]);

  const a = keyed(old);
  const b = keyed(next);
  for (const [id, value] of b) {
    if (!a.has(id)) changes.push(`${id} added`);
    else if (a.get(id) !== value) changes.push(`${id} changed`);
  }
  for (const id of a.keys()) {
    if (!b.has(id)) changes.push(`${id} removed`);
  }
  return changes;
}

export function fromDict(data: ReturnType<typeof toDict>): Goal {
  return {
    title: data.title,
    repo: data.repo,
    summary: data.summary ?? "",
    objectives: data.objectives.map((o) => ({ id: o.id, title: o.title, files: [...o.files], text: o.text })),
    rules: data.rules.map((i) => ({ id: i.id, text: i.text })),
    out_of_scope: data.out_of_scope.map((i) => ({ id: i.id, text: i.text })),
    verify: data.verify.map((c) => ({ id: c.id, command: c.command, requires: c.requires })),
  };
}
