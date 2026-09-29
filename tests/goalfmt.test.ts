import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as goalfmt from "../lib/core/goalfmt.ts";
import { GOAL } from "./support.ts";

const RULES = "## Rules\n- R1: Keep each file to one line.\n\n";

const errorsOf = (text: string) => goalfmt.parse(text)[1];

describe("parse", () => {
  test("valid goal", () => {
    const [goal, errors] = goalfmt.parse(GOAL);
    assert.deepEqual(errors, []);
    assert.equal(goal.title, "Demo task");
    assert.deepEqual(goal.repos, ["demo"]);
    assert.equal(goal.summary, "A small task for tests.");
    assert.deepEqual(goal.objectives.map((o) => o.id), ["O1", "O2"]);
    assert.equal(goal.objectives[0].title, "First file");
    assert.deepEqual(goal.objectives[1].files, ["b.txt", "docs/"]);
    assert.equal(goal.objectives[1].text, "b.txt says DONE.");
    assert.deepEqual(goal.rules.map((r) => r.id), ["R1"]);
    assert.deepEqual(goal.out_of_scope.map((x) => x.id), ["X1"]);
    assert.equal(goal.verify[0].command, "grep -q DONE a.txt && grep -q DONE b.txt");
  });

  test("requires and backticks", () => {
    const text = GOAL.replace("- V1: grep -q DONE a.txt && grep -q DONE b.txt",
      "- V1: `npm test`\n  Requires: `test -d node_modules`");
    const [goal, errors] = goalfmt.parse(text);
    assert.deepEqual(errors, []);
    assert.equal(goal.verify[0].command, "npm test");
    assert.equal(goal.verify[0].requires, "test -d node_modules");
  });

  test("multiline objective and rule continuation", () => {
    const text = GOAL.replace("a.txt says DONE.", "a.txt says DONE.\n\n- and nothing else")
      .replace("- R1: Keep each file to one line.", "- R1: Keep each file\n  to one line.");
    const [goal, errors] = goalfmt.parse(text);
    assert.deepEqual(errors, []);
    assert.equal(goal.objectives[0].text, "a.txt says DONE.\n\n- and nothing else");
    assert.equal(goal.rules[0].text, "Keep each file to one line.");
  });

  test("structure errors", () => {
    const cases: Record<string, string> = {
      "must start with '# <title>'": GOAL.replace("# Demo task\n", ""),
      "missing 'Repo:": GOAL.replace("Repo: demo\n", ""),
      "first line must be 'Files:": GOAL.replace("Files: a.txt\n", ""),
      "used more than once": GOAL.replace("### O2", "### O1"),
      "not a valid ID here": GOAL.replace("- R1:", "- O9:"),
      "unknown section": GOAL.replace("## Rules", "## Notes"),
      "out of order": GOAL.replace(RULES, "") + "\n" + RULES,
      "outside an objective": GOAL.replace("## Objectives\n", "## Objectives\nstray text\n"),
      "no Verify commands": GOAL.split("## Verify")[0],
      "says nothing after its Files": GOAL.replace("a.txt says DONE.\n", ""),
      "must be relative": GOAL.replace("Files: a.txt", "Files: /etc/passwd"),
      "must not contain '..'": GOAL.replace("Files: a.txt", "Files: ../x"),
      "may be followed only by one indented": GOAL.replace("grep -q DONE b.txt", "grep -q DONE b.txt\n  Also: x"),
      "holds only '- R<number>": GOAL.replace("- R1: Keep", "R1 Keep"),
    };
    for (const [expected, text] of Object.entries(cases)) {
      const errors = errorsOf(text);
      assert.ok(errors.some((e) => e.includes(expected)), `${expected}: ${JSON.stringify(errors)}`);
    }
  });

  test("render includes files", () => {
    const [goal] = goalfmt.parse(GOAL);
    assert.equal(goalfmt.render(goal.objectives[0]), "O1: First file\nFiles: a.txt\na.txt says DONE.");
  });
});

describe("match", () => {
  test("patterns", () => {
    const cases: [string, string, boolean][] = [
      ["a.txt", "a.txt", true],
      ["a.txt", "b/a.txt", false],
      ["src/features/demo", "src/features/demo/index.tsx", true],
      ["src/features/demo", "src/features/demo2/index.tsx", false],
      ["docs/", "docs/a/b.md", true],
      ["src/*.ts", "src/a.ts", true],
      ["src/*.ts", "src/x/a.ts", false],
      ["src/**/*.ts", "src/a.ts", true],
      ["src/**/*.ts", "src/x/y/a.ts", true],
      ["src/**", "src/x/y", true],
      ["a?.txt", "ab.txt", true],
      ["a?.txt", "a/.txt", false],
      ["a+b.txt", "a+b.txt", true],
    ];
    for (const [pattern, path, expected] of cases) {
      assert.equal(goalfmt.matches(pattern, path), expected, `${pattern} vs ${path}`);
    }
  });

  test("owners and uncovered", () => {
    const [goal] = goalfmt.parse(GOAL);
    assert.deepEqual(goalfmt.owners(goal, "docs/x.md").map((o) => o.id), ["O2"]);
    assert.deepEqual(goalfmt.uncovered(goal, ["a.txt", "README.md", "docs/y"]), ["README.md"]);
  });
});

describe("compare", () => {
  test("changes by id", () => {
    const [old] = goalfmt.parse(GOAL);
    const nextText = GOAL.replace("b.txt says DONE.", "b.txt says DONE twice.")
      .replace("### O1 First file\nFiles: a.txt\na.txt says DONE.\n\n", "")
      .replace("## Rules", "### O3\nFiles: c.txt\nc.txt exists.\n\n## Rules")
      .replace("# Demo task", "# Demo task 2");
    const [next, errors] = goalfmt.parse(nextText);
    assert.deepEqual(errors, []);
    assert.deepEqual(goalfmt.compare(old, next), ["title changed", "O2 changed", "O3 added", "O1 removed"]);
  });

  test("no changes", () => {
    const [old] = goalfmt.parse(GOAL);
    assert.deepEqual(goalfmt.compare(old, old), []);
  });
});

const MULTI = `# Two repos
Repo: web
Repo: ~/code/api

## Objectives

### O1
Files: web/a.txt
a.txt says DONE.

### O2
Files: api/server.txt, api/routes/
server.txt says DONE.

## Verify
- V1: grep -q DONE a.txt
  In: web
- V2: grep -q DONE server.txt
  Requires: true
  In: api
`;

describe("several repositories", () => {
  test("parse", () => {
    const [goal, errors] = goalfmt.parse(MULTI);
    assert.deepEqual(errors, []);
    assert.deepEqual(goal.repos, ["web", "~/code/api"]);
    assert.deepEqual(goal.repos.map(goalfmt.repoName), ["web", "api"]);
    assert.deepEqual(goal.verify.map((c) => [c.id, c.repo, c.requires]), [["V1", "web", ""], ["V2", "api", "true"]]);
  });

  test("structure errors", () => {
    const cases: Record<string, string> = {
      "must start with a repository name (web/ or api/)": MULTI.replace("Files: web/a.txt", "Files: a.txt"),
      "add an indented 'In: <repository>' line (web or api)": MULTI.replace("  In: web\n", ""),
      "'In: cli' is not one of the goal's repositories": MULTI.replace("In: api", "In: cli"),
      "two Repo: lines have the same folder name": MULTI.replace("Repo: web", "Repo: ~/other/api"),
      "'Repo: web' appears twice": MULTI.replace("Repo: web\n", "Repo: web\nRepo: web\n"),
    };
    for (const [expected, text] of Object.entries(cases)) {
      const errors = goalfmt.parse(text)[1];
      assert.ok(errors.some((e) => e.includes(expected)), `${expected}: ${JSON.stringify(errors)}`);
    }
  });

  test("one repository needs no prefixes or In", () => {
    assert.deepEqual(goalfmt.parse(GOAL)[1], []);
    const errors = goalfmt.parse(GOAL.replace("grep -q DONE b.txt", "grep -q DONE b.txt\n  In: other"))[1];
    assert.ok(errors.some((e) => e.includes("'In: other' is not one of the goal's repositories")), JSON.stringify(errors));
  });

  test("compare sees repositories and In", () => {
    const [old] = goalfmt.parse(MULTI);
    const [next] = goalfmt.parse(MULTI.replace("  In: web\n", "  In: api\n").replace("Repo: ~/code/api", "Repo: ~/src/api"));
    assert.deepEqual(goalfmt.compare(old, next), ["Repo changed", "V1 changed"]);
  });
});
