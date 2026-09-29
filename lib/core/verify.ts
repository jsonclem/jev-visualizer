// Verify commands. The exit code decides; Jev is never asked.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { stamp } from "./common.ts";
import type { Check } from "./goalfmt.ts";

const NOT_RUNNABLE: Record<number, string> = { 126: "not executable", 127: "command not found" };

export type VerifyResult = {
  command: string;
  state: "passed" | "failed" | "couldnt_run";
  reason: string;
  exit: number | null;
  seconds: number;
  log?: string;
};

// [exit code, or null on timeout; combined output]. Kills the whole process
// group on timeout, so a test runner's children do not outlive it.
export function shell(command: string, cwd: string, timeoutSeconds: number): Promise<[number | null, string]> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    child.stdout.setEncoding("utf8").on("data", (c: string) => chunks.push(c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => chunks.push(c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutSeconds * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exit = timedOut ? null : code ?? -(constants.signals[signal as keyof typeof constants.signals] ?? 1);
      resolve([exit, chunks.join("")]);
    });
  });
}

// Run one Verify entry. States: passed, failed, couldnt_run.
// couldnt_run is kept apart from failed: a stopped database is not a failing test.
export async function runCheck(
  check: Check,
  root: string,
  logDir: string,
  timeout: number,
  requiresTimeout: number,
): Promise<VerifyResult> {
  const started = performance.now();

  const finish = (state: VerifyResult["state"], reason: string, code: number | null, output: string, label: string) => {
    const result: VerifyResult = {
      command: check.command,
      state,
      reason,
      exit: code,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    };
    if (state !== "passed") {
      mkdirSync(logDir, { recursive: true });
      const log = path.join(logDir, `${check.id}-${stamp()}.log`);
      writeFileSync(log, `$ ${label}\n# exit: ${code ?? "none"}\n# ${reason}\n\n${output}`);
      result.log = log;
    }
    return result;
  };

  if (check.requires) {
    const [code, output] = await shell(check.requires, root, requiresTimeout);
    if (code === null) return finish("couldnt_run", `Requires timed out after ${requiresTimeout}s`, null, output, check.requires);
    if (code !== 0) {
      return finish("couldnt_run", `Requires failed (exit ${code}): ${check.requires}`, code, output, check.requires);
    }
  }

  const [code, output] = await shell(check.command, root, timeout);
  if (code === null) return finish("couldnt_run", `timed out after ${timeout}s`, null, output, check.command);
  if (code in NOT_RUNNABLE) return finish("couldnt_run", `${NOT_RUNNABLE[code]} (exit ${code})`, code, output, check.command);
  if (code !== 0) return finish("failed", `exit ${code}`, code, output, check.command);
  return finish("passed", "exit 0", 0, output, check.command);
}
