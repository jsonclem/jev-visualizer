// Test helpers: a fake Jev, a throwaway git repository, and in-process CLI runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Stop, io, out, paths } from "../lib/core/common.ts";
import * as config from "../lib/core/config.ts";
import * as jev from "../lib/core/jev.ts";
import type { Answers, Questions } from "../lib/core/jev.ts";
import { main as checkMain } from "../scripts/check.ts";
import { main as goalMain } from "../scripts/goal.ts";

// Deterministic stand-in for Jev.
//
// Goal checks pass. Scope is outside_scope when the diff contains EXTRA. An
// objective is met when its diff contains DONE.
export async function fakePost(state: unknown, questions: Questions): Promise<[Answers, string]> {
  const diff = String((state as { diff?: string }).diff ?? "");
  const answers: Answers = {};
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === "score") answers[key] = { type: "score", score: 3.0, confidence: 0.95 };
    else if (question.type === "choice") {
      answers[key] = { type: "choice", choice: diff.includes("EXTRA") ? "outside_scope" : "within_scope", confidence: 0.95 };
    } else if (key === "met") answers[key] = { type: "noul", noul: diff.includes("DONE") ? 0.95 : 0.3 };
    else answers[key] = { type: "noul", noul: 0.05 };
  }
  return [answers, "fake"];
}

export const GOAL = `# Demo task
Repo: demo
A small task for tests.

## Objectives

### O1 First file
Files: a.txt
a.txt says DONE.

### O2
Files: b.txt, docs/
b.txt says DONE.

## Rules
- R1: Keep each file to one line.

## Out of scope
- X1: The README.

## Verify
- V1: grep -q DONE a.txt && grep -q DONE b.txt
`;

const saved = { ...paths };
const savedHooks = { ...jev.hooks };

// A temporary git repository named `demo`, a temporary history folder, and the fake Jev.
export class TaskEnv {
  tmp = mkdtempSync(path.join(os.tmpdir(), "task-contract-test-"));
  repo = path.join(this.tmp, "demo");
  history = path.join(this.tmp, "history");

  constructor() {
    mkdirSync(this.repo);
    mkdirSync(this.history);
    Object.assign(paths, { tasks: this.history, env: path.join(this.history, ".env") });
    jev.hooks.post = fakePost;
    jev.hooks.requestTokens = savedHooks.requestTokens;
    jev.session.task = null;
    jev.session.records.length = 0;
    config.load();
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.name", "Test");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "commit.gpgsign", "false");
    this.write("a.txt", "a\n");
    this.write("b.txt", "b\n");
    this.git("add", "-A");
    this.git("commit", "-q", "-m", "Initial");
  }

  cleanup() {
    Object.assign(paths, saved);
    Object.assign(jev.hooks, savedHooks);
    jev.session.task = null;
    rmSync(this.tmp, { recursive: true, force: true });
  }

  git(...args: string[]) {
    return this.gitIn(this.repo, ...args);
  }

  gitIn(repo: string, ...args: string[]) {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  // Another committed repository beside `demo`, for multi-repository tasks.
  makeRepo(name: string, files: Record<string, string>) {
    const repo = path.join(this.tmp, name);
    mkdirSync(repo);
    this.gitIn(repo, "init", "-q", "-b", "main");
    this.gitIn(repo, "config", "user.name", "Test");
    this.gitIn(repo, "config", "user.email", "test@example.com");
    this.gitIn(repo, "config", "commit.gpgsign", "false");
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(repo, file), text);
    this.gitIn(repo, "add", "-A");
    this.gitIn(repo, "commit", "-q", "-m", "Initial");
    return repo;
  }

  write(name: string, text: string) {
    const file = path.join(this.repo, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  // [exit code, output] from a CLI's main(), run in the test repository.
  async run(main: (argv: string[]) => Promise<number>, argv: string[], stdin = "", cwd = this.repo): Promise<[number, string]> {
    const chunks: string[] = [];
    const saved = { write: io.write, stdin: io.stdin, cwd: process.cwd() };
    io.write = (text) => void chunks.push(text);
    io.stdin = () => stdin;
    process.chdir(cwd);
    let code: number;
    try {
      code = await main(argv);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      out(...err.lines);
      code = err.code;
    } finally {
      io.write = saved.write;
      io.stdin = saved.stdin;
      process.chdir(saved.cwd);
    }
    return [code, chunks.join("")];
  }

  goal(argv: string[], stdin = "", cwd = this.repo) {
    return this.run(goalMain, argv, stdin, cwd);
  }

  check(...argv: string[]) {
    return this.run(checkMain, argv);
  }

  checkIn(cwd: string, ...argv: string[]) {
    return this.run(checkMain, argv, "", cwd);
  }

  task() {
    const folders = readdirSync(this.history)
      .filter((name) => !name.startsWith("_") && statSync(path.join(this.history, name)).isDirectory());
    if (folders.length !== 1) throw new Error(`expected one task, found ${folders.length}`);
    return path.join(this.history, folders[0]);
  }
}
