import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS } from "../lib/core/common.ts";
import { decide } from "../lib/core/routing.ts";

const MET = { state: "met", score: 0.95 };
const PASSED = { state: "passed" };

test("uncovered files block first", () => {
  const [code, line, complete] = decide({ uncovered: ["x.py", "y.py"], blocked: true });
  assert.equal(code, EXIT_BLOCK);
  assert.ok(line.startsWith("ask the user: x.py, y.py not listed"));
  assert.equal(complete, false);
});

test("scope block", () => {
  const [code, line] = decide({ blocked: true, unsure: ["a"] });
  assert.equal(code, EXIT_BLOCK);
  assert.ok(line.startsWith("ask the user: show them this block"));
});

test("unsure escalates", () => {
  const [code, line] = decide({ unsure: ["a.py"] });
  assert.equal(code, EXIT_ESCALATE);
  assert.ok(line.includes("not confident enough about a.py"));
});

test("verify changed files escalates", () => {
  const [code, line, complete] = decide({
    verifyChanged: ["__pycache__/x.pyc"], objectives: [["O1", MET]], verify: [["V1", PASSED]],
  });
  assert.equal(code, EXIT_ESCALATE);
  assert.ok(line.startsWith("ask the user: Verify changed __pycache__/x.pyc."));
  assert.equal(complete, false);
});

test("unchecked before unmet", () => {
  const [code, line, complete] = decide({
    objectives: [
      ["O1", { state: "not_met", score: 0.4 }],
      ["O2", { state: "unchecked", reason: "too large: about 40000 tokens, limit 27200" }],
    ],
  });
  assert.equal(code, EXIT_PASS);
  assert.equal(line, "ask the user: O2 couldn't be checked (too large: about 40000 tokens, " +
    "limit 27200). They can split it with task-goal --revise.");
  assert.equal(complete, false);
});

test("first unmet in goal order", () => {
  const [, line] = decide({
    objectives: [["O1", MET], ["O3", { state: "not_met", score: 0.62 }], ["O2", { state: "not_met", score: 0.1 }]],
  });
  assert.equal(line, "work on O3 (not met, 0.62)");
});

test("in progress before not started", () => {
  const [, line] = decide({ objectives: [["O1", { state: "pending" }], ["O2", { state: "not_met", score: 0.5 }]] });
  assert.equal(line, "work on O2 (not met, 0.50)");
});

test("not started", () => {
  const [, line] = decide({ objectives: [["O1", MET], ["O2", { state: "pending" }]] });
  assert.equal(line, "work on O2 (not started)");
});

test("failed verify before couldn't run", () => {
  const [, line, complete] = decide({
    objectives: [["O1", MET]],
    verify: [
      ["V1", { state: "couldnt_run", reason: "Requires failed (exit 1): x" }],
      ["V2", { state: "failed", reason: "exit 1", log: "/t/V2.log" }],
    ],
  });
  assert.equal(line, "fix V2 (exit 1, log: /t/V2.log)");
  assert.equal(complete, false);
});

test("couldn't run", () => {
  const [, line, complete] = decide({
    objectives: [["O1", MET]],
    verify: [["V1", PASSED], ["V2", { state: "couldnt_run", reason: "timed out after 900s" }]],
  });
  assert.equal(line, "ask the user: V2 couldn't run (timed out after 900s).");
  assert.equal(complete, false);
});

test("complete with changes", () => {
  assert.deepEqual(decide({ objectives: [["O1", MET]], verify: [["V1", PASSED]] }),
    [EXIT_PASS, "commit; this closes the task", true]);
});

test("complete without changes", () => {
  const [, line, complete] = decide({ objectives: [["O1", MET]], verify: [["V1", PASSED]], hasChanges: false });
  assert.deepEqual([line, complete], ["none: the task is complete", true]);
});
