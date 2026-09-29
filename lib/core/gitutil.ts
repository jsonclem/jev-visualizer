// Git facts. Plain code: nothing here asks Jev.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT_ESCALATE, EXIT_PRECONDITION, die, splitLines } from "./common.ts";

const MAX_OUTPUT = 512 * 1024 * 1024;

export function git(root: string | null, args: string[], options: { check?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const proc = spawnSync("git", [...(root ? ["-C", root] : []), ...args], {
    encoding: "utf8",
    env: options.env,
    maxBuffer: MAX_OUTPUT,
  });
  const status = proc.status ?? 1;
  if (options.check && status !== 0) {
    die(EXIT_ESCALATE, `ESCALATE: git ${args.join(" ")} failed.`, (proc.stderr ?? "").trim());
  }
  return [status, proc.stdout ?? ""] as const;
}

export function gitPath(root: string, name: string) {
  const [, out] = git(root, ["rev-parse", "--git-path", name], { check: true });
  const found = out.trim();
  return path.isAbsolute(found) ? found : path.join(root, found);
}

export function gitRoot() {
  const [rc, root] = git(null, ["rev-parse", "--show-toplevel"]);
  if (rc !== 0 || !root.trim()) {
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: not inside a git repository.",
      "This skill requires git. The diff gate and the revert both depend on it.");
  }
  return root.trim();
}

export function optionalRoot() {
  const [rc, root] = git(null, ["rev-parse", "--show-toplevel"]);
  return rc === 0 && root.trim() ? root.trim() : null;
}

export function requireClean(root: string) {
  const [, status] = git(root, ["status", "--porcelain"]);
  if (status.trim()) {
    die(EXIT_PRECONDITION,
      "PRECONDITION FAILED: working tree is not clean.",
      "Commit or stash your own changes first. Nothing was modified.",
      "",
      status.trimEnd());
  }
}

export function headSha(root: string) {
  const [rc, sha] = git(root, ["rev-parse", "--short", "HEAD"]);
  if (rc !== 0) {
    die(EXIT_PRECONDITION, "PRECONDITION FAILED: repository has no commits.", "Make an initial commit first.");
  }
  return sha.trim();
}

export function headTree(root: string) {
  const [, tree] = git(root, ["rev-parse", "HEAD^{tree}"], { check: true });
  return tree.trim();
}

export function reachable(root: string, sha: string) {
  const [rc] = git(root, ["cat-file", "-e", `${sha}^{commit}`]);
  return rc === 0;
}

// Tree id of the working directory as it stands, untracked files included.
//
// Built in a throwaway index so the user's staging area is never touched. The
// gate, the commit and the pre-commit hook all compare this one fingerprint.
export function snapshot(root: string) {
  const realIndex = gitPath(root, "index");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "task-contract-"));
  try {
    const scratch = path.join(tmp, "index");
    if (existsSync(realIndex)) copyFileSync(realIndex, scratch);
    const env = { ...process.env, GIT_INDEX_FILE: scratch };
    git(root, ["add", "-A"], { check: true, env });
    const [, tree] = git(root, ["write-tree"], { check: true, env });
    return tree.trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Every path added, changed or deleted. Renames count as both paths.
export function changedPaths(root: string, since: string, tree: string) {
  const [, names] = git(root, ["diff", "--name-only", "--no-renames", since, tree], { check: true });
  return splitLines(names).filter((n) => n.trim());
}

// Unified diff, optionally limited to `paths`. null if git fails.
export function diff(
  root: string,
  since: string,
  tree: string,
  options: { paths?: string[]; context?: number; functionContext?: boolean } = {},
) {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-renames"];
  args.push(options.functionContext ? "--function-context" : `-U${options.context ?? 0}`);
  args.push(since, tree);
  if (options.paths) args.push("--", ...options.paths.map((p) => `:(literal)${p}`));
  const [rc, text] = git(root, args);
  return rc === 0 ? text : null;
}

// [path, text] per file in a unified diff.
export function splitFiles(text: string): [string, string][] {
  return text
    .split(/^(?=diff --git )/m)
    .filter((block) => block.trim())
    .map((block) => {
      const header = block.split("\n")[0];
      const match = /^diff --git a\/.* b\/(.*)$/.exec(header);
      return [match ? match[1] : header, block];
    });
}

export function usesConventionalCommits(root: string) {
  const [, log] = git(root, ["log", "-20", "--pretty=%s"]);
  const subjects = splitLines(log).filter((s) => s.trim());
  if (subjects.length < 5) return false;
  const pattern = /^\w+(\([^)]*\))?!?: /;
  const hits = subjects.filter((s) => pattern.test(s)).length;
  return hits >= Math.max(2, subjects.length * 0.3);
}
