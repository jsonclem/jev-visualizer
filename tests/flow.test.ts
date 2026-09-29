import assert from "node:assert/strict";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS, EXIT_PRECONDITION } from "../lib/core/common.ts";
import * as gate from "../lib/core/gate.ts";
import * as goalfmt from "../lib/core/goalfmt.ts";
import * as jev from "../lib/core/jev.ts";
import { fromPaths } from "../lib/core/repos.ts";
import * as tasks from "../lib/core/tasks.ts";
import { GOAL, TaskEnv } from "./support.ts";

const events = (task: string) =>
  readFileSync(path.join(task, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

let env: TaskEnv;
beforeEach(() => {
  env = new TaskEnv();
});
afterEach(() => env.cleanup());

describe("goal.ts", () => {
  test("check creates nothing", async () => {
    const [code, output] = await env.goal(["--check"], GOAL);
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("READY: 2 objectives, 1 rules, 1 out of scope, 1 verify."));
    assert.throws(() => env.task());
  });

  test("structure errors never reach Jev", async () => {
    const calls: number[] = [];
    jev.hooks.post = async () => {
      calls.push(1);
      return [{}, "fake"];
    };
    const [code, output] = await env.goal(["--check"], GOAL.replace("Files: a.txt\n", ""));
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("Nothing was sent to Jev"));
    assert.deepEqual(calls, []);
  });

  test("wrong repo rejected", async () => {
    const [code, output] = await env.goal(["--check"], GOAL.replace("Repo: demo", "Repo: other"));
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("this repository is 'demo'"));
  });

  test("record writes task folder", async () => {
    let [code, output] = await env.goal(["--record", "--slug", "demo"], GOAL);
    assert.equal(code, EXIT_PASS, output);
    const task = env.task();
    const meta = tasks.readMeta(task)!;
    assert.deepEqual([meta.status, meta.goal_version], ["ready", 1]);
    assert.equal(readFileSync(path.join(task, "goal.md"), "utf8"), GOAL);
    assert.equal(readFileSync(path.join(task, "goal.v1.md"), "utf8"), GOAL);
    assert.equal(JSON.parse(readFileSync(path.join(task, "goal.json"), "utf8")).objectives[0].id, "O1");
    assert.equal(tasks.readState(task).objectives.O1.state, "pending");
    assert.deepEqual(events(task).map((e) => e.event), ["record"]);
    assert.ok(readFileSync(path.join(task, "jev.jsonl"), "utf8"));

    [code, output] = await env.goal(["--record", "--slug", "again"], GOAL);
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("already has an open task"));
  });

  test("revise tracks ids", async () => {
    await env.goal(["--record", "--slug", "demo"], GOAL);
    const revised = GOAL.replace("b.txt says DONE.", "b.txt says DONE, in capitals.")
      .replace("### O1 First file\nFiles: a.txt\na.txt says DONE.\n\n", "");
    let [code, output] = await env.goal(["--revise"], revised);
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("O2 changed"));
    assert.ok(output.includes("O1 removed"));
    const task = env.task();
    const meta = tasks.readMeta(task)!;
    assert.deepEqual([meta.goal_version, meta.retired_ids], [2, ["O1"]]);
    assert.deepEqual(Object.keys(tasks.readState(task).objectives), ["O2"]);

    [code, output] = await env.goal(["--revise"], revised.replace("### O2", "### O1"));
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("never reused"));
  });

  test("hand-edited goal stops the gate", async () => {
    await env.goal(["--record", "--slug", "demo"], GOAL);
    await env.check("--start");
    const goalMd = path.join(env.task(), "goal.md");
    chmodSync(goalMd, 0o644);
    writeFileSync(goalMd, GOAL + "\n");
    env.write("a.txt", "DONE\n");
    const [code, output] = await env.check();
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("goal.md changed outside the scripts"));
  });
});

describe("check.ts", () => {
  const start = async (goal = GOAL) => {
    let [code, output] = await env.goal(["--record", "--slug", "demo"], goal);
    assert.equal(code, EXIT_PASS, output);
    [code, output] = await env.check("--start");
    assert.equal(code, EXIT_PASS, output);
    return output;
  };

  test("gate requires start", async () => {
    await env.goal(["--record", "--slug", "demo"], GOAL);
    const [code, output] = await env.check();
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("is ready, not started"));
  });

  test("full task reaches complete", async () => {
    let output = await start();
    assert.ok(output.includes("NEXT: work on O1 (not started)"));

    env.write("a.txt", "DONE\n");
    let code: number;
    [code, output] = await env.check();
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("✓ O1"));
    assert.ok(output.includes("◇ O2"));
    assert.ok(output.includes("NEXT: work on O2 (not started)"));
    [code, output] = await env.check("--commit", "-m", "Mark a done");
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("NEXT: work on O2 (not started)"));

    env.write("b.txt", "DONE\n");
    [code, output] = await env.check();
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("✓ V1"));
    assert.ok(output.includes("NEXT: commit; this closes the task"));
    [code, output] = await env.check("--commit", "-m", "Mark b done");
    assert.ok(output.includes("GOAL COMPLETE. The task is closed."));
    const task = env.task();
    assert.equal(tasks.readMeta(task)!.status, "complete");
    assert.deepEqual(events(task).map((e) => e.event).slice(-2), ["commit", "complete"]);
  });

  test("objective result is reused", async () => {
    await start();
    env.write("a.txt", "DONE\n");
    await env.check();
    await env.check("--commit", "-m", "Mark a done");
    const asked: Record<string, unknown>[] = [];
    const real = jev.hooks.post;
    jev.hooks.post = (state, questions) => {
      asked.push(state as Record<string, unknown>);
      return real(state, questions);
    };
    env.write("b.txt", "not yet\n");
    await env.check();
    const completion = asked.filter((s) => "objective" in s);
    assert.deepEqual(completion.map((s) => String(s.objective).split("\n")[0].split(":")[0]), ["O2"]);
  });

  test("uncovered file blocks without Jev", async () => {
    await start();
    const asked: number[] = [];
    jev.hooks.post = async () => {
      asked.push(1);
      return [{}, "fake"];
    };
    env.write("README.md", "hi\n");
    let [code, output] = await env.check();
    assert.equal(code, EXIT_BLOCK, output);
    assert.ok(output.includes("NEXT: ask the user: README.md not listed"));
    assert.deepEqual(asked, []);
    [code, output] = await env.check("--commit", "-m", "Sneak it in");
    assert.equal(code, EXIT_PRECONDITION);
  });

  test("scope block", async () => {
    await start();
    env.write("a.txt", "DONE EXTRA\n");
    const [code, output] = await env.check();
    assert.equal(code, EXIT_BLOCK, output);
    assert.ok(output.includes("BLOCKED: this change contains work the goal does not ask for."));
    assert.equal(tasks.readState(env.task()).last_pass, null);
  });

  test("low confidence escalates", async () => {
    await start();
    const real = jev.hooks.post;
    jev.hooks.post = async (state, questions) => {
      const [answers, model] = await real(state, questions);
      if (answers.verdict) answers.verdict.confidence = 0.3;
      return [answers, model];
    };
    env.write("a.txt", "DONE\n");
    const [code, output] = await env.check();
    assert.equal(code, EXIT_ESCALATE, output);
    assert.ok(output.includes("NEXT: ask the user: Jev is not confident enough about a.txt"));
  });

  test("failing verify points at log", async () => {
    await start(GOAL.replace("grep -q DONE a.txt && grep -q DONE b.txt", "echo nope; exit 1"));
    env.write("a.txt", "DONE\n");
    env.write("b.txt", "DONE\n");
    const [code, output] = await env.check();
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("✗ V1"));
    assert.ok(output.includes("NEXT: fix V1 (exit 1, log: "));
    assert.ok(output.includes("GOAL NOT YET COMPLETE."));
  });

  test("verify that writes files escalates", async () => {
    await start(GOAL.replace("grep -q DONE a.txt && grep -q DONE b.txt", "touch generated.txt"));
    env.write("a.txt", "DONE\n");
    env.write("b.txt", "DONE\n");
    let [code, output] = await env.check();
    assert.equal(code, EXIT_ESCALATE, output);
    assert.ok(output.includes("NEXT: ask the user: Verify changed generated.txt."));
    [code, output] = await env.check("--commit", "-m", "Finish both");
    assert.equal(code, EXIT_PRECONDITION);
  });

  test("verify rerun on committed work", async () => {
    await start(GOAL.replace("grep -q DONE a.txt && grep -q DONE b.txt", "grep -q DONE a.txt\n  Requires: test -f ready"));
    env.write("a.txt", "DONE\n");
    env.write("b.txt", "DONE\n");
    let [code, output] = await env.check();
    assert.ok(output.includes("NEXT: ask the user: V1 couldn't run (Requires failed (exit 1): test -f ready)."), output);
    await env.check("--commit", "-m", "Finish both");
    writeFileSync(path.join(env.repo, ".git", "info", "exclude"), "ready\n");
    env.write("ready", "");
    [code, output] = await env.check();
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("NO NEW CHANGES"));
    assert.ok(output.includes("GOAL COMPLETE. The task is closed."));
    assert.equal(tasks.readMeta(env.task())!.status, "complete");
  });

  test("too large objective is unchecked", async () => {
    await start();
    env.write("a.txt", "DONE\n");
    const [goal] = goalfmt.parse(GOAL);
    const tree = env.git("rev-parse", "HEAD^{tree}").trim();
    env.git("add", "-A");
    const staged = env.git("write-tree").trim();
    jev.hooks.requestTokens = () => 10 ** 6;
    const records = await gate.completion(fromPaths({ demo: env.repo }), goal,
      { demo: env.git("rev-parse", "HEAD").trim() }, { demo: staged }, {});
    assert.notEqual(tree, staged);
    assert.equal(records.O1.state, "unchecked");
    assert.ok(String(records.O1.reason).startsWith("too large: about 1000000 tokens"));
    assert.equal(records.O2.state, "pending");
  });

  test("close", async () => {
    await start();
    const [code, output] = await env.check("--close");
    assert.equal(code, EXIT_PASS, output);
    assert.equal(tasks.readMeta(env.task())!.status, "closed");
  });
});

describe("several repositories", () => {
  let api: string;
  const goalFor = (apiPath: string) => `# Two repos
Repo: demo
Repo: ${apiPath}

## Objectives

### O1
Files: demo/a.txt
a.txt says DONE.

### O2
Files: api/server.txt
server.txt says DONE.

## Rules
- R1: Keep each file to one line.

## Verify
- V1: grep -q DONE a.txt
  In: demo
- V2: grep -q DONE server.txt
  In: api
`;

  beforeEach(() => {
    api = env.makeRepo("api", { "server.txt": "server\n" });
  });

  test("record names every repository", async () => {
    const [code, output] = await env.goal(["--record", "--slug", "both"], goalFor(api));
    assert.equal(code, EXIT_PASS, output);
    const task = env.task();
    assert.equal(path.basename(task).endsWith("-demo+api-both"), true, task);
    assert.deepEqual(tasks.readMeta(task)!.repos, { demo: realpathSync(env.repo), api: realpathSync(api) });
  });

  test("a bare name that is not this repository is rejected", async () => {
    const [code, output] = await env.goal(["--check"], goalFor(api).replace(`Repo: ${api}`, "Repo: api"));
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("Repo: api has no path, and this repository is 'demo'"), output);
  });

  test("a repository in another open task is rejected", async () => {
    const single = GOAL.replace("Repo: demo", "Repo: api").replace("Files: a.txt", "Files: server.txt")
      .replace("Files: b.txt, docs/", "Files: server.txt");
    let [code, output] = await env.goal(["--record", "--slug", "api-only"], single, api);
    assert.equal(code, EXIT_PASS, output);
    [code, output] = await env.goal(["--record", "--slug", "both"], goalFor(api));
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("a repository in this goal already has an open task"), output);
  });

  test("start needs every repository clean and hooks each", async () => {
    await env.goal(["--record", "--slug", "both"], goalFor(api));
    writeFileSync(path.join(api, "server.txt"), "dirty\n");
    let [code, output] = await env.check("--start");
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("working tree is not clean in api"), output);
    env.gitIn(api, "checkout", "--", "server.txt");
    [code, output] = await env.check("--start");
    assert.equal(code, EXIT_PASS, output);
    for (const repo of [env.repo, api]) {
      assert.ok(readFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "utf8").includes("check.ts"));
    }
  });

  test("one task gates, commits and completes across both", async () => {
    await env.goal(["--record", "--slug", "both"], goalFor(api));
    await env.check("--start");
    const asked: Record<string, unknown>[] = [];
    const real = jev.hooks.post;
    jev.hooks.post = (state, questions) => {
      asked.push(state as Record<string, unknown>);
      return real(state, questions);
    };

    env.write("a.txt", "DONE\n");
    writeFileSync(path.join(api, "server.txt"), "not yet\n");
    let [code, output] = await env.check();
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("demo/a.txt  within_scope"), output);
    assert.ok(output.includes("api/server.txt  within_scope"), output);
    assert.ok(output.includes("✓ O1") && output.includes("✗ O2"), output);
    const scoped = asked.find((s) => s.file === "api/server.txt")!;
    assert.ok(String(scoped.diff).includes("a/api/server.txt"), String(scoped.diff));

    [code, output] = await env.check("--commit", "-m", "Start both");
    assert.equal(code, EXIT_PASS, output);
    for (const repo of [env.repo, api]) assert.equal(env.gitIn(repo, "log", "-1", "--format=%s").trim(), "Start both");

    writeFileSync(path.join(api, "server.txt"), "DONE\n");
    [code, output] = await env.checkIn(api);
    assert.equal(code, EXIT_PASS, output);
    assert.ok(output.includes("✓ V1") && output.includes("✓ V2"), output);
    assert.ok(output.includes("NEXT: commit; this closes the task"), output);
    [code, output] = await env.checkIn(api, "--commit", "-m", "Finish api");
    assert.ok(output.includes("GOAL COMPLETE. The task is closed."), output);
    assert.equal(env.gitIn(env.repo, "log", "-1", "--format=%s").trim(), "Start both");
    assert.equal(env.gitIn(api, "log", "-1", "--format=%s").trim(), "Finish api");
    assert.equal(tasks.readMeta(env.task())!.status, "complete");
  });

  test("an unlisted file in the other repository blocks", async () => {
    await env.goal(["--record", "--slug", "both"], goalFor(api));
    await env.check("--start");
    writeFileSync(path.join(api, "README.md"), "hi\n");
    const [code, output] = await env.check();
    assert.equal(code, EXIT_BLOCK, output);
    assert.ok(output.includes("NEXT: ask the user: api/README.md not listed"), output);
  });

  test("a started task keeps its repositories", async () => {
    await env.goal(["--record", "--slug", "both"], goalFor(api));
    await env.check("--start");
    const [code, output] = await env.goal(["--revise"], GOAL);
    assert.equal(code, EXIT_PRECONDITION);
    assert.ok(output.includes("a started task keeps its repositories"), output);
  });
});
