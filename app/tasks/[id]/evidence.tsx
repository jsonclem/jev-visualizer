import type { Clarity, Config, ObjectiveRecord, ScopeResult, TaskEvent, VerifyRecord } from "@/lib/tasks";

const CLARITY_THRESHOLDS: Record<string, string> = {
  precision: "goal_clarity.min_precision_score",
  boundedness: "goal_clarity.min_boundedness_score",
  drift_license: "goal_clarity.drift_license_block",
  multiple_conditions: "objective_clarity.multiple_conditions_block",
  not_checkable: "objective_clarity.not_checkable_block",
  vague: "objective_clarity.vague_block",
  is_objective: "objective_clarity.rule_is_objective_block",
};

export const OBJECTIVE_MARK: Record<ObjectiveRecord["state"], { mark: string; text: string; label: string }> = {
  met: { mark: "✓", text: "text-pass", label: "met" },
  not_met: { mark: "✗", text: "text-amend", label: "not met" },
  unchecked: { mark: "⊘", text: "text-muted", label: "couldn't check" },
  pending: { mark: "◇", text: "text-faint", label: "not started" },
};

export const VERIFY_MARK: Record<VerifyRecord["state"], { mark: string; text: string; label: string }> = {
  passed: { mark: "✓", text: "text-pass", label: "passed" },
  failed: { mark: "✗", text: "text-block", label: "failed" },
  couldnt_run: { mark: "⊘", text: "text-muted", label: "couldn't run" },
  pending: { mark: "◇", text: "text-faint", label: "waiting" },
};

export function hasEvidence(event: TaskEvent) {
  return !!(event.clarity || event.scope || event.objectives || event.changes?.length || event.notes?.length);
}

export function Evidence({ event, config }: { event: TaskEvent; config: Config }) {
  return (
    <div className="mt-4 max-w-3xl space-y-4">
      {event.changes && event.changes.length > 0 && (
        <ul className="border-l-2 border-amend bg-amend/[0.06] py-2 pr-4 pl-4 font-mono text-xs">
          {event.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}
      {event.clarity && <ClarityView clarity={event.clarity} config={config} />}
      {event.scope && event.scope.length > 0 && (
        <ScopeView results={event.scope} drift={event.drift ?? {}} config={config} />
      )}
      {event.objectives && <Snapshot objectives={event.objectives} verify={event.verify ?? {}} config={config} />}
      {event.notes?.map((note) => (
        <p key={note} className="font-mono text-xs text-muted">
          note · {note}
        </p>
      ))}
    </div>
  );
}

function ClarityView({ clarity, config }: { clarity: Clarity; config: Config }) {
  const goal = Object.entries(clarity.goal ?? {});
  const items = [...Object.entries(clarity.objectives ?? {}), ...Object.entries(clarity.rules ?? {})];
  return (
    <details className="group/d frame rounded-sm border border-line bg-panel/60">
      <Summary label="Goal check">
        <span>
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </Summary>
      <div className="grid gap-y-2.5 border-t border-line px-4 py-4">
        {goal.map(([name, value]) => {
          const threshold = num(config, CLARITY_THRESHOLDS[name]);
          if (typeof value === "number") {
            const tripped = threshold !== undefined && value >= threshold;
            return (
              <Row key={name} name={name}>
                <Bar value={value} threshold={threshold} tone={tripped ? "bg-block" : "bg-muted/70"} />
                <span>{value.toFixed(2)}</span>
              </Row>
            );
          }
          const low = threshold !== undefined && value.score < threshold;
          return (
            <Row key={name} name={name}>
              <Bar value={value.score} max={3} threshold={threshold} tone={low ? "bg-block" : "bg-pass"} />
              <span>
                {value.score.toFixed(2)}
                <span className="text-faint"> c{value.confidence.toFixed(2)}</span>
              </span>
            </Row>
          );
        })}
        {items.length > 0 && <div className="my-1 border-t border-dashed border-line" />}
        {items.map(([id, values]) => (
          <div key={id} className="grid gap-1.5">
            <span className="font-mono text-xs text-paper">{id}</span>
            {Object.entries(values).map(([name, value]) => {
              const threshold = num(config, CLARITY_THRESHOLDS[name]);
              const tripped = threshold !== undefined && value >= threshold;
              return (
                <Row key={name} name={name.replace(/_/g, " ")}>
                  <Bar value={value} threshold={threshold} tone={tripped ? "bg-block" : "bg-muted/70"} />
                  <span className={tripped ? "text-block" : undefined}>{value.toFixed(2)}</span>
                </Row>
              );
            })}
          </div>
        ))}
      </div>
    </details>
  );
}

function ScopeView({
  results,
  drift,
  config,
}: {
  results: ScopeResult[];
  drift: Record<string, number>;
  config: Config;
}) {
  const driftBlock = num(config, "scope.drift_block");
  const minVerdict = num(config, "scope.min_verdict_confidence");
  const outside = results.filter((file) => file.verdict !== "within_scope").length;

  return (
    <div className="frame rounded-sm border border-line bg-panel/60">
      <div className="grid gap-y-2.5 px-4 py-4">
        {Object.entries(drift).map(([name, value]) => {
          const tripped = driftBlock !== undefined && value >= driftBlock;
          return (
            <Row key={name} name={name.replace(/^drift_/, "drift · ")}>
              <Bar value={value} threshold={driftBlock} tone={tripped ? "bg-block" : "bg-muted/70"} />
              <span className={tripped ? "text-block" : undefined}>{value.toFixed(2)}</span>
            </Row>
          );
        })}
      </div>
      <details className="border-t border-line">
        <Summary label={`${results.length} ${results.length === 1 ? "file" : "files"}`}>
          {outside ? (
            <span className="text-block">{outside} judged outside scope</span>
          ) : (
            <span className="text-pass">all within scope</span>
          )}
        </Summary>
        <ul className="space-y-1.5 border-t border-line px-4 py-3 font-mono text-xs">
          {results.map((file) => (
            <li key={file.path} className="flex items-baseline gap-3">
              <span className={`w-16 shrink-0 ${file.verdict === "within_scope" ? "text-pass" : "text-block"}`}>
                {file.verdict === "within_scope" ? "within" : file.verdict.replace(/_scope$/, "")}
              </span>
              <span
                className={`w-10 shrink-0 ${
                  minVerdict !== undefined && file.confidence < minVerdict ? "text-amend" : "text-faint"
                }`}
              >
                {file.confidence.toFixed(2)}
              </span>
              <span className="min-w-0 truncate text-muted" title={file.path}>
                {file.path}
              </span>
              {file.parts > 1 && (
                <span className="shrink-0 text-faint" title={`checked in ${file.parts} parts`}>
                  ×{file.parts}
                </span>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Snapshot({
  objectives,
  verify,
  config,
}: {
  objectives: Record<string, ObjectiveRecord>;
  verify: Record<string, VerifyRecord>;
  config: Config;
}) {
  const threshold = num(config, "completion.item_complete");
  return (
    <div className="frame rounded-sm border border-line bg-panel/60 px-4 py-4">
      <ul className="space-y-2 font-mono text-xs">
        {Object.entries(objectives).map(([id, record]) => {
          const mark = OBJECTIVE_MARK[record.state];
          return (
            <li key={id} className="grid grid-cols-[1rem_2.5rem_1fr] items-center gap-2">
              <span className={mark.text}>{mark.mark}</span>
              <span className="text-paper">{id}</span>
              {record.score !== undefined ? (
                <span className="flex items-center gap-2">
                  <span className="flex-1">
                    <Bar
                      value={record.score}
                      threshold={threshold}
                      tone={record.state === "met" ? "bg-pass" : "bg-amend"}
                    />
                  </span>
                  <span className={mark.text}>{record.score.toFixed(2)}</span>
                </span>
              ) : (
                <span className="truncate text-muted">{record.reason ?? mark.label}</span>
              )}
            </li>
          );
        })}
        {Object.entries(verify).map(([id, record]) => {
          const mark = VERIFY_MARK[record.state];
          return (
            <li key={id} className="grid grid-cols-[1rem_2.5rem_1fr] items-center gap-2">
              <span className={mark.text}>{mark.mark}</span>
              <span className="text-paper">{id}</span>
              <span className="truncate text-muted">
                {mark.label}
                {record.reason && record.state !== "passed" ? ` · ${record.reason}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Summary({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <summary className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 font-mono text-xs text-muted hover:text-paper">
      <span className="chevron inline-block text-faint transition-transform">›</span>
      <span className="tracking-widest text-faint uppercase">{label}</span>
      {children}
    </summary>
  );
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,6.5rem)_minmax(2.5rem,1fr)_auto] items-center gap-3 font-mono text-xs">
      <span className="truncate text-muted">{name}</span>
      {children}
    </div>
  );
}

export function Bar({
  value,
  max = 1,
  threshold,
  tone,
}: {
  value: number;
  max?: number;
  threshold?: number;
  tone: string;
}) {
  return (
    <div className="relative h-1.5">
      <div className="segments absolute inset-0 bg-line">
        <div
          className={`absolute inset-y-0 left-0 ${tone}`}
          style={{ width: `${Math.min(100, (value / max) * 100)}%` }}
        />
      </div>
      {threshold !== undefined && (
        <div
          className="absolute -inset-y-1 w-px bg-paper/70"
          style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }}
          title={`threshold ${threshold}`}
        />
      )}
    </div>
  );
}

export function num(config: Config, key: string | undefined) {
  const value = key ? config[key] : undefined;
  return typeof value === "number" ? value : undefined;
}
