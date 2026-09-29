import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TASKS_DIR =
  process.env.TASKS_DIR || path.join(os.homedir(), "Desktop", "task-contract", "history");

export type Status = "ready" | "active" | "complete" | "closed" | "unknown";

export type Kind =
  | "record"
  | "start"
  | "resume"
  | "pass"
  | "block"
  | "escalate"
  | "commit"
  | "complete"
  | "revise"
  | "reject"
  | "accept"
  | "close"
  | "stop"
  | "other";

export type Objective = { id: string; title: string; files: string[]; text: string };
export type Item = { id: string; text: string };
export type Check = { id: string; command: string; requires: string };

// goal.json, written by goal.py from the approved goal.md.
export type Goal = {
  version: number;
  title: string;
  repo: string;
  summary: string;
  objectives: Objective[];
  rules: Item[];
  out_of_scope: Item[];
  verify: Check[];
};

export type ObjectiveRecord = {
  state: "met" | "not_met" | "unchecked" | "pending";
  score?: number;
  reason?: string;
  files?: string[];
  at?: string;
};

export type VerifyRecord = {
  state: "passed" | "failed" | "couldnt_run" | "pending";
  reason?: string;
  exit?: number | null;
  seconds?: number;
  command?: string;
  log?: string;
  at?: string;
};

export type ScopeResult = {
  path: string;
  verdict: string;
  confidence: number;
  drift: Record<string, number>;
  parts: number;
};

export type Clarity = {
  goal?: Record<string, number | { score: number; confidence: number }>;
  objectives?: Record<string, Record<string, number>>;
  rules?: Record<string, Record<string, number>>;
};

// One line of events.jsonl. Fields beyond `at` and `event` depend on the event.
export type TaskEvent = {
  at: string;
  event: string;
  kind: Kind;
  result?: "pass" | "block" | "escalate";
  reason?: string;
  detail?: string;
  version?: number;
  changes?: string[];
  clarity?: Clarity;
  notes?: string[];
  scope?: ScopeResult[];
  drift?: Record<string, number>;
  tripped?: Record<string, number>;
  blocked?: string[];
  unsure?: string[];
  uncovered?: string[];
  verify_changed?: string[];
  objectives?: Record<string, ObjectiveRecord>;
  verify?: Record<string, VerifyRecord>;
  complete?: boolean;
  next?: string;
  has_changes?: boolean;
  sha?: string;
  subject?: string;
  base?: string;
};

export type Config = Record<string, number | string>;

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
  goal: Goal | null;
  goalText: string;
  objectives: Record<string, ObjectiveRecord>;
  verify: Record<string, VerifyRecord>;
  logs: Record<string, string>;
  next: string | null;
  events: TaskEvent[];
};

type Meta = {
  slug?: string;
  repo?: string;
  base_commit?: string | null;
  created?: string;
  closed?: string;
  status?: string;
  config?: Config;
};

type State = {
  objectives?: Record<string, ObjectiveRecord>;
  verify?: Record<string, VerifyRecord>;
  next?: string | null;
};

const LOG_TAIL = 4000;

function kindOf(event: { event: string; result?: string }): Kind {
  switch (event.event) {
    case "record":
    case "start":
    case "resume":
    case "commit":
    case "complete":
    case "revise":
    case "close":
      return event.event;
    case "gate":
      return event.result === "pass" ? "pass" : event.result === "block" ? "block" : "escalate";
    case "revise-reject":
      return "reject";
    case "config-accept":
      return "accept";
    case "goal-changed":
    case "config-changed":
      return "stop";
    default:
      return "other";
  }
}

async function readOptional(file: string) {
  try {
    return await readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch {
    return "";
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ file, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseEvents(text: string): TaskEvent[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line);
      return [{ ...event, kind: kindOf(event) }];
    } catch {
      return [];
    }
  });
}

// The tail of each current Verify log, so a failure's output is one click away.
async function readLogs(dir: string, verify: Record<string, VerifyRecord>) {
  const logs: Record<string, string> = {};
  for (const [id, record] of Object.entries(verify)) {
    if (!record.log) continue;
    const file = path.join(dir, "verify", path.basename(record.log));
    const text = await readOptional(file);
    if (text) logs[id] = text.length > LOG_TAIL ? "…" + text.slice(-LOG_TAIL) : text;
  }
  return logs;
}

async function readTask(id: string): Promise<Task | null> {
  const dir = path.join(TASKS_DIR, id);
  const meta = await readJson<Meta>(path.join(dir, "meta.json"));
  if (!meta) return null;
  const [goal, state, goalText, eventsText] = await Promise.all([
    readJson<Goal>(path.join(dir, "goal.json")),
    readJson<State>(path.join(dir, "state.json")),
    readOptional(path.join(dir, "goal.md")),
    readOptional(path.join(dir, "events.jsonl")),
  ]);
  const events = parseEvents(eventsText);
  const verify = state?.verify ?? {};
  const status = meta.status;
  return {
    id,
    title: goal?.title || humanize(meta.slug || id),
    repo: meta.repo ? path.basename(meta.repo) : "unknown repo",
    repoPath: meta.repo ?? "",
    baseCommit: meta.base_commit ?? "",
    status:
      status === "ready" || status === "active" || status === "complete" || status === "closed" ? status : "unknown",
    created: meta.created ?? null,
    closed: meta.closed ?? null,
    lastAt: events.at(-1)?.at ?? meta.created ?? null,
    config: meta.config ?? {},
    goal,
    goalText,
    objectives: state?.objectives ?? {},
    verify,
    logs: await readLogs(dir, verify),
    next: state?.next ?? null,
    events,
  };
}

export async function listTasks(): Promise<Task[]> {
  const entries = await readdir(/*turbopackIgnore: true*/ TASKS_DIR, { withFileTypes: true }).catch(() => []);
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_"))
      .map((entry) => readTask(entry.name)),
  );
  const open = (task: Task) => Number(task.status === "active" || task.status === "ready");
  return tasks
    .filter((task): task is Task => task !== null)
    .sort((a, b) => open(b) - open(a) || Date.parse(b.lastAt ?? "") - Date.parse(a.lastAt ?? ""));
}

export async function getTask(id: string): Promise<Task | null> {
  if (id !== path.basename(id) || id.startsWith(".") || id.startsWith("_")) return null;
  return readTask(id);
}

function humanize(slug: string) {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
