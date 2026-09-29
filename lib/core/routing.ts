// The NEXT line. Jev's judgments go in; a fixed table decides what happens next.
//
// Pure: no files, no git, no Jev. Every branch is covered by tests/routing.test.ts.

import { EXIT_BLOCK, EXIT_ESCALATE, EXIT_PASS } from "./common.ts";

export const REVERT = 'git stash push -u -m "task-contract: blocked change"';

export type Record_ = { state: string; score?: number; reason?: string; exit?: number | null; log?: string };

export type Decision = [code: number, next: string, complete: boolean];

// `objectives` and `verify` are [id, record] in goal order. A record has a
// `state`, and may have `score`, `reason`, `exit` and `log`. `verifyChanged`
// lists files the Verify commands created or changed.
export function decide({
  uncovered = [],
  blocked = false,
  unsure = [],
  verifyChanged = [],
  objectives = [],
  verify = [],
  hasChanges = true,
}: {
  uncovered?: string[];
  blocked?: boolean;
  unsure?: string[];
  verifyChanged?: string[];
  objectives?: [string, Record_][];
  verify?: [string, Record_][];
  hasChanges?: boolean;
}): Decision {
  if (uncovered.length) {
    return [EXIT_BLOCK,
      `ask the user: ${uncovered.join(", ")} not listed in any objective's Files. ` +
      `Revert only if they approve (${REVERT}), or they revise the goal with task-goal to list it.`,
      false];
  }
  if (blocked) {
    return [EXIT_BLOCK, `ask the user: show them this block. Revert only if they approve (${REVERT}).`, false];
  }
  if (unsure.length) {
    return [EXIT_ESCALATE, `ask the user: Jev is not confident enough about ${unsure.join(", ")}. They decide.`, false];
  }
  if (verifyChanged.length) {
    return [EXIT_ESCALATE,
      `ask the user: Verify changed ${verifyChanged.join(", ")}. They ignore it ` +
      "(.gitignore) or change the command; then run check.ts again.",
      false];
  }

  const first = (state: string) => objectives.find(([, record]) => record.state === state);

  const unchecked = first("unchecked");
  if (unchecked) {
    const [id, record] = unchecked;
    return [EXIT_PASS,
      `ask the user: ${id} couldn't be checked (${record.reason ?? "unknown reason"}). ` +
      "They can split it with task-goal --revise.",
      false];
  }
  const notMet = first("not_met");
  if (notMet) {
    const [id, record] = notMet;
    return [EXIT_PASS, `work on ${id} (not met, ${(record.score ?? 0).toFixed(2)})`, false];
  }
  const pending = first("pending");
  if (pending) return [EXIT_PASS, `work on ${pending[0]} (not started)`, false];

  const failed = verify.find(([, record]) => record.state === "failed");
  if (failed) {
    const [id, record] = failed;
    return [EXIT_PASS, `fix ${id} (${record.reason ?? "failed"}, log: ${record.log ?? "none"})`, false];
  }
  const stuck = verify.find(([, record]) => record.state === "couldnt_run" || record.state === "pending");
  if (stuck) {
    const [id, record] = stuck;
    return [EXIT_PASS, `ask the user: ${id} couldn't run (${record.reason ?? "not run"}).`, false];
  }

  if (hasChanges) return [EXIT_PASS, "commit; this closes the task", true];
  return [EXIT_PASS, "none: the task is complete", true];
}
