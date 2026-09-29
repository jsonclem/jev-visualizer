// The repositories a goal covers. Plain code: paths, git top folders, names.

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "./gitutil.ts";
import { isRepoPath, repoName, type Goal } from "./goalfmt.ts";

// `paths` maps each repository's name (its folder name) to its git top folder.
export type Repos = { names: string[]; paths: Record<string, string>; multi: boolean };

export function fromPaths(paths: Record<string, string>): Repos {
  const names = Object.keys(paths);
  return { names, paths, multi: names.length > 1 };
}

// A path as goals write it: relative to the repository it is in, prefixed
// with that repository's name when the goal covers more than one.
export function qualify(repos: Repos, name: string, file: string) {
  return repos.multi ? `${name}/${file}` : file;
}

// [repository name, path inside it] for a qualified path.
export function unqualify(repos: Repos, file: string): [string, string] {
  if (!repos.multi) return [repos.names[0], file];
  const at = file.indexOf("/");
  return [file.slice(0, at), file.slice(at + 1)];
}

// [repos, errors, notes]. A bare name must be the repository `cwdRoot` is;
// a path must be the top folder of a git repository.
export function resolveRepos(goal: Goal, cwdRoot: string | null): [Repos, string[], string[]] {
  const paths: Record<string, string> = {};
  const errors: string[] = [];
  const notes: string[] = [];
  for (const spec of goal.repos) {
    const name = repoName(spec);
    if (!isRepoPath(spec)) {
      if (cwdRoot === null) {
        notes.push(`Repo: ${spec} was not checked: not inside a git repository.`);
      } else if (path.basename(cwdRoot) !== spec) {
        errors.push(`Repo: ${spec} has no path, and this repository is '${path.basename(cwdRoot)}'. ` +
          "Give its path, or run from inside it.");
      } else {
        paths[name] = cwdRoot;
      }
      continue;
    }
    const expanded = spec.startsWith("~") ? path.join(os.homedir(), spec.slice(1)) : spec;
    const absolute = path.resolve(cwdRoot ?? process.cwd(), expanded);
    const [rc, top] = existsSync(absolute) ? git(absolute, ["rev-parse", "--show-toplevel"]) : [1, ""];
    if (rc !== 0 || !top.trim() || realpathSync(top.trim()) !== realpathSync(absolute)) {
      errors.push(`Repo: ${spec} is not the top folder of a git repository.`);
      continue;
    }
    paths[name] = top.trim();
  }
  return [fromPaths(paths), errors, notes];
}
