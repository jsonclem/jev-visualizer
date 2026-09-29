// TypeSafe's Jev API: judgment only. Every exchange is recorded in the task's jev.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT_ESCALATE, EXIT_PRECONDITION, die, now, paths, pyDumps, sortKeys, textHash } from "./common.ts";
import { CFG, configHash, num } from "./config.ts";

const API_URL = "https://api.typesafe.ai/v1/systemone";

export type Question = Record<string, unknown> & { type: "score" | "noul" | "choice" };
export type Questions = Record<string, Question>;
export type Answer = {
  type: string;
  noul?: number;
  score?: number;
  choice?: string;
  confidence?: number;
  [key: string]: unknown;
};
export type Answers = Record<string, Answer>;

// Every Jev exchange is appended to the task's jev.jsonl as soon as it returns.
// Before a task exists (the checks at --record) it waits in `records`.
export const session = { task: null as string | null, id: "", records: [] as unknown[] };

// Replaceable so tests can stand in for Jev without the network.
export const hooks = {
  post: realPost,
  requestTokens: estimateRequest,
};

export function estimateTokens(value: unknown) {
  const text = typeof value === "string" ? value : pyDumps(value);
  return Math.floor(text.length / num("request_budget.chars_per_token")) + 1;
}

export function budget() {
  return num("request_budget.max_tokens") * num("request_budget.headroom");
}

function estimateRequest(state: unknown, questions: Questions) {
  return estimateTokens(state) + Math.max(...Object.values(questions).map(estimateTokens));
}

export function requestTokens(state: unknown, questions: Questions) {
  return hooks.requestTokens(state, questions);
}

export function fits(state: unknown, questions: Questions) {
  return estimateRequest(state, questions) <= budget();
}

export function apiKey(): string {
  const fromEnv = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
  if (fromEnv) return fromEnv.trim();
  if (existsSync(paths.env)) {
    for (let raw of readFileSync(paths.env, "utf8").split("\n")) {
      raw = raw.trim();
      if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
      const at = raw.indexOf("=");
      const name = raw.slice(0, at).trim();
      const value = raw.slice(at + 1).trim();
      if ((name === "JEV_API_KEY" || name === "TYPESAFE_API_KEY") && value) return value.replace(/^['"]+|['"]+$/g, "");
    }
  }
  die(EXIT_PRECONDITION, "PRECONDITION FAILED: no API key.", `Set JEV_API_KEY in ${paths.env} or in the environment.`);
}

export function setTask(task: string | null) {
  session.task = task;
  flush();
}

function flush() {
  if (session.task === null || !session.records.length) return;
  appendFileSync(path.join(session.task, "jev.jsonl"), session.records.map((r) => JSON.stringify(r) + "\n").join(""));
  session.records.length = 0;
}

function record(check: string, context: unknown, questions: Questions, answers: Answers, model: string, cached = false) {
  session.records.push({
    time: now(),
    check,
    model,
    config_hash: configHash(),
    session: session.id || null,
    cached,
    context,
    questions,
    answers,
  });
  flush();
}

function cacheFile(state: unknown, questions: Questions) {
  const key = textHash(pyDumps(sortKeys([CFG.model, state, questions]))).slice(7);
  return path.join(paths.tasks, "_cache", `${key}.json`);
}

// One Jev request. `check` names which check asked; `context` records what the
// state was built from. With `cache`, an identical earlier request is reused:
// goal checks repeat across --check, --record and --revise.
export async function ask(state: unknown, questions: Questions, check: string, context: unknown, cache = false) {
  const cached = cache ? cacheFile(state, questions) : null;
  if (cached && existsSync(cached)) {
    const answers = JSON.parse(readFileSync(cached, "utf8")) as Answers;
    record(check, context, questions, answers, String(CFG.model), true);
    return answers;
  }
  const [answers, model] = await hooks.post(state, questions);
  record(check, context, questions, answers, model);
  if (cached) {
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, JSON.stringify(answers));
  }
  return answers;
}

async function realPost(state: unknown, questions: Questions): Promise<[Answers, string]> {
  const body = JSON.stringify({ state, model: CFG.model, questions });
  let delay = 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      die(EXIT_ESCALATE, `ESCALATE: could not reach Jev (${err instanceof Error ? err.message : err}). Nothing was checked.`);
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 400);
      if (response.status === 401) die(EXIT_PRECONDITION, "PRECONDITION FAILED: Jev rejected the API key (401).");
      if ((response.status === 429 || response.status === 529) && attempt < 2) {
        await sleep(Number(response.headers.get("retry-after")) * 1000 || delay);
        delay *= 2;
        continue;
      }
      die(EXIT_ESCALATE, `ESCALATE: Jev returned HTTP ${response.status}. Nothing was checked.`, text);
    }
    const data = (await response.json()) as { answers?: Answers; model?: string };
    const answers = data && typeof data === "object" ? data.answers : undefined;
    if (!answers || typeof answers !== "object" || Object.keys(questions).some((k) => !(k in answers))) {
      die(EXIT_ESCALATE, "ESCALATE: Jev returned an unexpected response. Nothing was checked.", JSON.stringify(data).slice(0, 400));
    }
    return [answers, data.model ?? String(CFG.model)];
  }
  die(EXIT_ESCALATE, "ESCALATE: could not reach Jev. Nothing was checked.");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
