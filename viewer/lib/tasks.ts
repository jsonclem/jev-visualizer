import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TASKS_DIR =
  process.env.TASKS_DIR || path.join(os.homedir(), "Desktop", "task-contract", "history");

export type Status = "active" | "complete" | "closed" | "unknown";

export type Kind =
  | "init"
  | "resume"
  | "pass"
  | "block"
  | "escalate"
  | "commit"
  | "complete"
  | "amend"
  | "reject"
  | "accept"
  | "close"
  | "stop"
  | "other";

// One evidence block under an event, e.g. "clarity:" and its indented rows.
export type Section = { name: string; value: string; items: string[] };

export type HistoryEvent = {
  at: string;
  event: string;
  kind: Kind;
  detail: string;
  sections: Section[];
};

export type GoalPart = { at: string | null; text: string };

export type Config = Record<string, number | string>;

type Meta = {
  id?: string;
  slug?: string;
  repo?: string;
  base_commit?: string;
  created?: string;
  closed?: string;
  status?: string;
  config?: Config;
};

export type Task = {
  id: string;
  title: string;
  repo: string;
  repoPath: string;
  baseCommit: string;
  status: Status;
  created: string | null;
  closed: string | null;
  lastAt: string | null;
  config: Config;
  goal: GoalPart[];
  objectives: string[];
  history: HistoryEvent[];
};

const KINDS: Record<string, Kind> = {
  init: "init",
  resume: "resume",
  "gate PASS": "pass",
  "gate BLOCK": "block",
  gate: "escalate",
  commit: "commit",
  complete: "complete",
  amend: "amend",
  "amend REJECT": "reject",
  "accept REJECT": "reject",
  "goal-accept": "accept",
  "config-accept": "accept",
  close: "close",
  "goal-changed": "stop",
  "config-changed": "stop",
};

// check.py writes `{timestamp}  {event:<14} {detail}`, then evidence indented
// 42 columns. Multi-line evidence (a correction) continues unindented.
const HEADER = /^(\d{4}-\d{2}-\d{2}T\S+)  (.{14,}?) (.*)$/;
const INDENT = " ".repeat(42);
const SECTION = /^([a-z][\w ]*):(?: ([\s\S]*))?$/;
const CORRECTION = /^\[correction ([^\]]*)\][ \t]*$/m;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)/;

function parseHistory(text: string): HistoryEvent[] {
  const events: { at: string; event: string; detail: string; lines: string[] }[] = [];
  for (const line of text.replace(/\n+$/, "").split("\n")) {
    const header = HEADER.exec(line);
    const current = events.at(-1);
    if (header) {
      events.push({ at: header[1], event: header[2].trim(), detail: header[3], lines: [] });
    } else if (!current) {
      continue;
    } else if (line.startsWith(INDENT)) {
      current.lines.push(line.slice(INDENT.length));
    } else if (current.lines.length) {
      current.lines[current.lines.length - 1] += "\n" + line;
    } else {
      current.detail += "\n" + line;
    }
  }
  return events.map(({ lines, ...event }) => ({
    ...event,
    kind: KINDS[event.event] ?? "other",
    sections: groupSections(lines),
  }));
}

function groupSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (const line of lines) {
    if (line.startsWith("  ")) {
      if (!sections.length) sections.push({ name: "", value: "", items: [] });
      sections[sections.length - 1].items.push(line.slice(2));
    } else if (line.trim()) {
      const match = SECTION.exec(line);
      sections.push({
        name: match ? match[1] : "",
        value: match ? (match[2] ?? "") : line,
        items: [],
      });
    }
  }
  return sections;
}

function parseGoal(text: string): GoalPart[] {
  const [original, ...rest] = text.split(CORRECTION);
  const parts: GoalPart[] = [{ at: null, text: original.trim() }];
  for (let i = 0; i < rest.length; i += 2) {
    parts.push({ at: rest[i], text: rest[i + 1].trim() });
  }
  return parts;
}

// Mirrors check.py goal_items(): each section contributes its bulleted or
// numbered lines, or the whole section when it has none. Completion scores in
// history are listed in this same order.
function goalItems(goal: GoalPart[]): string[] {
  return goal.flatMap(({ text }) => {
    if (!text) return [];
    const bullets = text.split("\n").flatMap((line) => {
      const match = BULLET.exec(line);
      return match ? [match[1]] : [];
    });
    return bullets.length ? bullets : [text];
  });
}

async function readOptional(file: string) {
  try {
    return await readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch {
    return "";
  }
}

async function readTask(id: string): Promise<Task | null> {
  const dir = path.join(TASKS_DIR, id);
  let meta: Meta;
  try {
    meta = JSON.parse(await readFile(/*turbopackIgnore: true*/ path.join(dir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
  const [goalText, historyText] = await Promise.all([
    readOptional(path.join(dir, "goal.txt")),
    readOptional(path.join(dir, "history.txt")),
  ]);
  const history = parseHistory(historyText);
  const goal = parseGoal(goalText);
  const status = meta.status;
  return {
    id,
    title: humanize(meta.slug || id),
    repo: meta.repo ? path.basename(meta.repo) : "unknown repo",
    repoPath: meta.repo ?? "",
    baseCommit: meta.base_commit ?? "",
    status: status === "active" || status === "complete" || status === "closed" ? status : "unknown",
    created: meta.created ?? null,
    closed: meta.closed ?? null,
    lastAt: history.at(-1)?.at ?? meta.created ?? null,
    config: meta.config ?? {},
    goal,
    objectives: goalItems(goal),
    history,
  };
}

export async function listTasks(): Promise<Task[]> {
  const entries = await readdir(/*turbopackIgnore: true*/ TASKS_DIR, { withFileTypes: true }).catch(() => []);
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => readTask(entry.name)),
  );
  return tasks
    .filter((task): task is Task => task !== null)
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        Date.parse(b.lastAt ?? "") - Date.parse(a.lastAt ?? ""),
    );
}

export async function getTask(id: string): Promise<Task | null> {
  if (id !== path.basename(id) || id.startsWith(".")) return null;
  return readTask(id);
}

function humanize(slug: string) {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
