// Paths, exit codes and output shared by goal.ts and check.ts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); // <root>/lib/core/common.ts

// Mutable so tests can point them at a temporary folder.
export const paths = {
  config: path.join(ROOT, "config.json"),
  tasks: path.join(ROOT, "history"),
  // Outside the skill folders, so sharing a skill never shares the key.
  env: path.join(ROOT, "history", ".env"),
  goalCli: path.join(ROOT, "scripts", "goal.ts"),
  checkCli: path.join(ROOT, "scripts", "check.ts"),
};

export const EXIT_PASS = 0;
export const EXIT_BLOCK = 1;
export const EXIT_ESCALATE = 2;
export const EXIT_PRECONDITION = 3;

// Thrown by die() so tests can see the exit code and output without exiting.
export class Stop extends Error {
  code: number;
  lines: string[];

  constructor(code: number, lines: string[]) {
    super(`exit ${code}`);
    this.code = code;
    this.lines = lines;
  }
}

// Mutable so tests can capture output and supply stdin.
export const io = {
  write: (text: string) => {
    process.stdout.write(text);
  },
  stdin: (): string => {
    if (process.stdin.isTTY) return "";
    try {
      return readFileSync(0, "utf8");
    } catch {
      return "";
    }
  },
};

export function out(...lines: string[]) {
  for (const line of lines) io.write(line + "\n");
}

export function die(code: number, ...lines: string[]): never {
  throw new Stop(code, lines);
}

// Script entry point: print a Stop's lines and exit with its code.
// A crash must never read as a verdict, so anything unexpected exits 2.
export async function run(main: () => Promise<number>) {
  let code: number;
  try {
    code = await main();
  } catch (err) {
    if (err instanceof Stop) {
      out(...err.lines);
      code = err.code;
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      out(`ESCALATE: failed unexpectedly (${error.name}: ${error.message}).`,
        "Nothing was checked, reverted, or committed.",
        "",
        (error.stack ?? "").trimEnd());
      code = EXIT_ESCALATE;
    }
  }
  process.exitCode = code;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

// Local time with its UTC offset, to the second: 2026-09-29T06:09:32-04:00.
export function now(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${today(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function today(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function stamp(date = new Date()) {
  return `${today(date).replaceAll("-", "")}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function textHash(text: string) {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

export function readStdin() {
  return io.stdin().trim();
}

// Lines as Python's str.splitlines() gives them: no empty last line.
export function splitLines(text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// Serialized as Python's json.dumps writes it (", " and ": ", non-ASCII escaped),
// so request-size estimates match what Jev is budgeted against.
export function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
  return "{" + Object.entries(value as object).map(([k, v]) => `${pyDumps(k)}: ${pyDumps(v)}`).join(", ") + "}";
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function fixed(value: number, digits = 2) {
  return value.toFixed(digits);
}
