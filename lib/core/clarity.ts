// Jev's checks on the wording of a goal. Structure is goalfmt's job; this is judgment.
//
// One request for the whole goal, then one small request per objective and per
// rule, so a failure names the item and a long goal never overflows a request.

import { fixed, textHash } from "./common.ts";
import { num } from "./config.ts";
import { render, type Goal } from "./goalfmt.ts";
import * as jev from "./jev.ts";
import type { Questions } from "./jev.ts";

// Two axes. `precision` is whether done is determinable. `boundedness` is
// whether the wording confines the work. A goal can be precise and still
// license drift, and the scope gate cannot catch that: if the goal permits
// extra work, extra work is in scope. Whether there is a deliverable, a done
// condition, or several tasks is now structure: Objectives and Verify.
export function goalQuestions(): Questions {
  return {
    precision: {
      type: "score",
      instructions: "How precisely does `goal` define what counts as completing it?",
      criteria: [
        "States an intention with no concrete deliverable; what counts as done is unstated",
        "Names a general area of work; the specific changes are left to the reader",
        "Names a concrete outcome, but some boundaries are unstated",
        "Names a concrete outcome and its boundaries; done is determinable from the text",
      ],
    },
    boundedness: {
      type: "score",
      instructions: "How tightly does `goal` confine the work to what it states?",
      criteria: [
        "Invites or permits work beyond what it states",
        "States a target but leaves the extent of the work to the reader's judgment",
        "Mostly bounded; a small amount is left to the reader",
        "Confines the work to exactly what it states; nothing is left to add",
      ],
    },
    drift_license: {
      type: "noul",
      instructions: "Does `goal` give permission to do work it does not specify?",
      criteria: {
        true: {
          what: "Grants latitude to add, tidy, or decide beyond the stated result",
          examples: [
            "feel free to clean up anything else",
            "use your judgment on the rest",
            "and whatever else makes sense",
            "while you are in there, improve what you see",
          ],
        },
        false: {
          what: "Grants no latitude beyond the stated result",
          examples: ["Cap the retry loop in charge() at three attempts"],
        },
      },
    },
    vague_qualifier: {
      type: "noul",
      instructions:
        "Does `goal` rely on a subjective qualifier such as better, properly, " +
        "robust, clean, or appropriate, whose meaning the reader must decide?",
    },
    requires_inference: {
      type: "noul",
      instructions:
        "Would a competent engineer have to decide something `goal` leaves " +
        "unstated that would change which files or which behavior are affected?",
    },
    unbounded_target: {
      type: "noul",
      instructions:
        "Does `goal` name an unbounded target such as all files, everywhere, " +
        "or the whole codebase, rather than specific ones?",
    },
    open_ended: {
      type: "noul",
      instructions:
        "Does `goal` rely on an open-ended verb such as improve, clean up, " +
        "optimize, or refactor without naming a specific target?",
    },
  };
}

// Each asks about a defect, so a high value is bad.
export function objectiveQuestions(): Questions {
  return {
    multiple_conditions: {
      type: "noul",
      instructions:
        "Does `objective` state more than one independent condition, where one " +
        "could be met while another is missed?",
    },
    not_checkable: {
      type: "noul",
      instructions:
        "Would judging whether `objective` is met need more than reading the " +
        "changes to the files on its Files line, such as running the app, a " +
        "person's judgment, or files it does not list?",
    },
    vague: {
      type: "noul",
      instructions:
        "Does `objective` rely on a subjective qualifier such as better, properly, " +
        "robust, clean, or appropriate, whose meaning the reader must decide?",
    },
  };
}

export function ruleQuestions(): Questions {
  return {
    is_objective: {
      type: "noul",
      instructions:
        "Does `rule` ask for a change to be made, rather than limit how changes " +
        "are made or what must stay the same?",
    },
  };
}

const GOAL_HINTS: Record<string, string> = {
  drift_license: "remove the permission to do unspecified work",
  vague_qualifier: "replace the subjective qualifier with a concrete condition",
  requires_inference: "state what is currently left for the reader to decide",
  unbounded_target: "name the specific files or components",
  open_ended: "name the specific change instead of an open-ended verb",
};
const HINT_FLOOR: Record<string, number> = { requires_inference: 0.85 };

const OBJECTIVE_CHECKS: Record<string, [string, string]> = {
  multiple_conditions: ["objective_clarity.multiple_conditions_block",
    "more than one condition: split it into separate objectives"],
  not_checkable: ["objective_clarity.not_checkable_block",
    "can't be judged from its files: name the files, or move it to Verify"],
  vague: ["objective_clarity.vague_block",
    "subjective wording: replace it with a concrete condition"],
};

export type ClarityResults = {
  goal?: Record<string, unknown>;
  objectives?: Record<string, Record<string, number>>;
  rules?: Record<string, Record<string, number>>;
};

// [ok, report lines, results for the event log].
export async function check(goalText: string, goal: Goal): Promise<[boolean, string[], ClarityResults]> {
  const context = { goal_hash: textHash(goalText) };
  const report: string[] = [];
  const failures: string[] = [];
  const results: ClarityResults = {};

  const questions = goalQuestions();
  const state = { goal: goalText };
  if (!jev.fits(state, questions)) {
    return [false, ["  - The goal is too long for one Jev request. Shorten it or split the task."], {}];
  }
  const answers = await jev.ask(state, questions, "clarity", context, true);
  const precision = answers.precision;
  const boundedness = answers.boundedness;
  const noul = Object.fromEntries(
    Object.entries(answers).filter(([, v]) => v.type === "noul").map(([k, v]) => [k, v.noul as number]),
  );
  results.goal = {
    precision: { score: precision.score, confidence: precision.confidence },
    boundedness: { score: boundedness.score, confidence: boundedness.confidence },
    ...noul,
  };
  report.push(
    "  goal:",
    `    precision          ${fixed(precision.score!)} of 3.00  (confidence ${fixed(precision.confidence!)})`,
    `    boundedness        ${fixed(boundedness.score!)} of 3.00  (confidence ${fixed(boundedness.confidence!)})`,
    ...Object.entries(noul).map(([k, v]) => `    ${k.padEnd(18)} ${fixed(v)}`),
  );
  const goalFailures: string[] = [];
  if (noul.drift_license >= num("goal_clarity.drift_license_block")) {
    goalFailures.push("The goal gives permission to do work it does not specify. " +
      "Every scope check downstream would treat that extra work as authorized.");
  }
  if (precision.score! < num("goal_clarity.min_precision_score")) {
    goalFailures.push(`Not precise enough to adjudicate against (precision ${fixed(precision.score!)}, ` +
      `needs ${fixed(num("goal_clarity.min_precision_score"))}).`);
  }
  if (boundedness.score! < num("goal_clarity.min_boundedness_score")) {
    goalFailures.push(`The wording does not confine the work (boundedness ${fixed(boundedness.score!)}, ` +
      `needs ${fixed(num("goal_clarity.min_boundedness_score"))}).`);
  }
  if (precision.confidence! < num("goal_clarity.min_confidence")) {
    goalFailures.push("Jev is not confident enough reading how precise the goal is.");
  }
  if (boundedness.confidence! < num("goal_clarity.min_confidence")) {
    goalFailures.push("Jev is not confident enough reading how bounded the goal is.");
  }
  if (goalFailures.length) {
    failures.push(...goalFailures.map((f) => `goal: ${f}`));
    failures.push(...Object.entries(GOAL_HINTS)
      .filter(([key]) => (noul[key] ?? 0) >= (HINT_FLOOR[key] ?? 0.6))
      .map(([, hint]) => `goal, to fix: ${hint}`));
  }

  results.objectives = {};
  for (const objective of goal.objectives) {
    const answers = await jev.ask({ objective: render(objective) }, objectiveQuestions(), "clarity-objective",
      { ...context, id: objective.id }, true);
    const values = Object.fromEntries(Object.keys(OBJECTIVE_CHECKS).map((k) => [k, answers[k].noul as number]));
    results.objectives[objective.id] = values;
    const bad = Object.entries(values).filter(([k, v]) => v >= num(OBJECTIVE_CHECKS[k][0]));
    report.push(`  ${objective.id.padEnd(4)} ` + Object.entries(values).map(([k, v]) => `${k} ${fixed(v)}`).join("  ") +
      (bad.length ? "" : "  ok"));
    failures.push(...bad.map(([k, v]) => `${objective.id}: ${OBJECTIVE_CHECKS[k][1]} (${fixed(v)})`));
  }

  results.rules = {};
  for (const rule of goal.rules) {
    const answers = await jev.ask({ rule: rule.text }, ruleQuestions(), "clarity-rule", { ...context, id: rule.id }, true);
    const value = answers.is_objective.noul as number;
    results.rules[rule.id] = { is_objective: value };
    const bad = value >= num("objective_clarity.rule_is_objective_block");
    report.push(`  ${rule.id.padEnd(4)} is_objective ${fixed(value)}` + (bad ? "" : "  ok"));
    if (bad) failures.push(`${rule.id}: asks for a change, so it is an objective: move it to Objectives (${fixed(value)})`);
  }

  if (failures.length) report.push("", "  Not ready:", ...failures.map((f) => `  - ${f}`));
  return [!failures.length, report, results];
}
