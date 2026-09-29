import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runCheck } from "../lib/core/verify.ts";

let root: string;
let logs: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "task-contract-verify-"));
  logs = path.join(root, "verify");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const runOne = (command: string, requires = "", timeout = 10) =>
  runCheck({ id: "V1", command, requires }, root, logs, timeout, 5);

test("passed writes no log", async () => {
  const result = await runOne("true");
  assert.deepEqual([result.state, result.exit], ["passed", 0]);
  assert.equal(result.log, undefined);
  assert.equal(existsSync(logs), false);
});

test("failed keeps output", async () => {
  const result = await runOne("echo boom; exit 3");
  assert.deepEqual([result.state, result.reason], ["failed", "exit 3"]);
  assert.ok(readFileSync(result.log!, "utf8").includes("boom"));
});

test("missing command couldn't run", async () => {
  const result = await runOne("definitely-not-a-command-4821");
  assert.equal(result.state, "couldnt_run");
  assert.equal(result.reason, "command not found (exit 127)");
});

test("requires failure skips command", async () => {
  const result = await runOne("touch ran", "false");
  assert.equal(result.state, "couldnt_run");
  assert.equal(result.reason, "Requires failed (exit 1): false");
  assert.equal(existsSync(path.join(root, "ran")), false);
});

test("requires success runs command", async () => {
  const result = await runOne("touch ran", "true");
  assert.equal(result.state, "passed");
  assert.ok(existsSync(path.join(root, "ran")));
});

test("timeout couldn't run", async () => {
  const result = await runOne("sleep 5", "", 1);
  assert.deepEqual([result.state, result.reason], ["couldnt_run", "timed out after 1s"]);
  assert.ok(result.seconds < 4);
});
