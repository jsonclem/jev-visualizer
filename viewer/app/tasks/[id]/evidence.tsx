import type { Config, Section } from "@/lib/tasks";

const SCORE = /^(\w+)\s+([\d.]+) of ([\d.]+)\s+\(confidence ([\d.]+)\)$/;
const NOUL = /^(\w+)\s+([\d.]+)$/;
const FILE = /^(.+?)  (\w+) \(([\d.]+)\)$/;
const DRIFT = /^(\w+)\s+([\d.]+)\s+\(max\)$/;
const ITEM = /^\[([\d.]+)\] (.*)$/;

export type ScopeFile = { path: string; verdict: string; confidence: number; parts: number };
export type Drift = { name: string; value: number };

export function parseScope(section: Section) {
  const files = new Map<string, ScopeFile>();
  const drifts: Drift[] = [];
  for (const item of section.items) {
    const drift = DRIFT.exec(item.trim());
    const file = FILE.exec(item.trim());
    if (drift) drifts.push({ name: drift[1], value: +drift[2] });
    else if (file) {
      const part = { path: file[1], verdict: file[2], confidence: +file[3], parts: 1 };
      const seen = files.get(part.path);
      files.set(part.path, seen ? { ...worse(seen, part), parts: seen.parts + 1 } : part);
    }
  }
  return { files: [...files.values()], drifts };
}

// check.py splits a large file's diff into parts and logs each part on its own
// line under the same path. Keep the part that decides the gate: an
// outside_scope verdict (the most confident one), else the least confident part.
function worse(a: ScopeFile, b: ScopeFile) {
  const aOutside = a.verdict !== "within_scope";
  const bOutside = b.verdict !== "within_scope";
  if (aOutside !== bOutside) return aOutside ? a : b;
  if (aOutside) return a.confidence >= b.confidence ? a : b;
  return a.confidence <= b.confidence ? a : b;
}

export function parseCompletion(section: Section) {
  return section.items.flatMap((item) => {
    const match = ITEM.exec(item.trim());
    return match ? [{ value: +match[1], text: match[2] }] : [];
  });
}

const CLARITY_THRESHOLDS: Record<string, string> = {
  precision: "goal_clarity.min_precision_score",
  boundedness: "goal_clarity.min_boundedness_score",
  drift_license: "goal_clarity.drift_license_block",
};

export function Evidence({ sections, config }: { sections: Section[]; config: Config }) {
  if (!sections.length) return null;
  return (
    <div className="mt-4 max-w-3xl space-y-4">
      {sections.map((section, i) => {
        switch (section.name) {
          case "clarity":
            return <Clarity key={i} section={section} config={config} />;
          case "scope":
            return <Scope key={i} section={section} config={config} />;
          case "completion":
            return <Completion key={i} section={section} config={config} />;
          case "correction":
            return (
              <blockquote
                key={i}
                className="border-l-2 border-amend bg-amend/[0.06] py-3 pr-4 pl-4 text-sm leading-relaxed whitespace-pre-wrap"
              >
                {section.value.trim()}
              </blockquote>
            );
          default:
            return (
              <div key={i} className="font-mono text-xs text-muted">
                {section.name && <span className="text-faint">{section.name}: </span>}
                <span className="whitespace-pre-wrap">{section.value}</span>
                {section.items.length > 0 && (
                  <pre className="mt-1 whitespace-pre-wrap">{section.items.join("\n")}</pre>
                )}
              </div>
            );
        }
      })}
    </div>
  );
}

function Clarity({ section, config }: { section: Section; config: Config }) {
  const notes = section.items.filter((item) => item.startsWith("- "));
  const scores = section.items.flatMap((item) => {
    const match = SCORE.exec(item.trim());
    return match ? [{ name: match[1], value: +match[2], max: +match[3], confidence: +match[4] }] : [];
  });
  const nouls = section.items.flatMap((item) => {
    const match = NOUL.exec(item.trim());
    return match ? [{ name: match[1], value: +match[2] }] : [];
  });
  const minConfidence = num(config, "goal_clarity.min_confidence");

  return (
    <>
      <details className="group/d frame rounded-sm border border-line bg-panel/60">
        <Summary label="Goal clarity">
          {scores.map((score) => (
            <span key={score.name}>
              {score.name} <span className="text-paper">{score.value.toFixed(2)}</span>
            </span>
          ))}
        </Summary>
        <div className="grid gap-y-2.5 border-t border-line px-4 py-4">
          {scores.map((score) => {
            const threshold = num(config, CLARITY_THRESHOLDS[score.name]);
            const low = threshold !== undefined && score.value < threshold;
            const unsure = minConfidence !== undefined && score.confidence < minConfidence;
            return (
              <Row key={score.name} name={score.name}>
                <Bar value={score.value} max={score.max} threshold={threshold} tone={low ? "bg-block" : "bg-pass"} />
                <span>
                  {score.value.toFixed(2)}
                  <span className={unsure ? "text-block" : "text-faint"}> c{score.confidence.toFixed(2)}</span>
                </span>
              </Row>
            );
          })}
          <div className="my-1 border-t border-dashed border-line" />
          {nouls.map((noul) => {
            const threshold = num(config, CLARITY_THRESHOLDS[noul.name]);
            const tripped = threshold !== undefined && noul.value >= threshold;
            return (
              <Row key={noul.name} name={noul.name}>
                <Bar value={noul.value} threshold={threshold} tone={tripped ? "bg-block" : "bg-muted/70"} />
                <span>{noul.value.toFixed(2)}</span>
              </Row>
            );
          })}
        </div>
      </details>
      {notes.map((note, i) => (
        <p key={i} className="flex gap-2 text-sm text-block">
          <span aria-hidden>▲</span>
          {note.slice(2)}
        </p>
      ))}
    </>
  );
}

function Scope({ section, config }: { section: Section; config: Config }) {
  const { files, drifts } = parseScope(section);
  const driftBlock = num(config, "scope.drift_block");
  const minVerdict = num(config, "scope.min_verdict_confidence");
  const outside = files.filter((file) => file.verdict !== "within_scope").length;

  return (
    <div className="frame rounded-sm border border-line bg-panel/60">
      <div className="grid gap-y-2.5 px-4 py-4">
        {drifts.map((drift) => {
          const tripped = driftBlock !== undefined && drift.value >= driftBlock;
          return (
            <Row key={drift.name} name={drift.name.replace(/^drift_/, "drift · ")}>
              <Bar value={drift.value} threshold={driftBlock} tone={tripped ? "bg-block" : "bg-muted/70"} />
              <span className={tripped ? "text-block" : undefined}>{drift.value.toFixed(2)}</span>
            </Row>
          );
        })}
      </div>
      {files.length > 0 && (
        <details className="border-t border-line">
          <Summary label={`${files.length} ${files.length === 1 ? "file" : "files"}`}>
            {outside ? (
              <span className="text-block">{outside} judged outside scope</span>
            ) : (
              <span className="text-pass">all within scope</span>
            )}
          </Summary>
          <ul className="space-y-1.5 border-t border-line px-4 py-3 font-mono text-xs">
            {files.map((file) => (
              <li key={file.path} className="flex items-baseline gap-3">
                <span
                  className={`w-16 shrink-0 ${file.verdict === "within_scope" ? "text-pass" : "text-block"}`}
                >
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
      )}
    </div>
  );
}

function Completion({ section, config }: { section: Section; config: Config }) {
  const threshold = num(config, "completion.item_complete");
  const items = parseCompletion(section);
  if (!items.length) {
    return <p className="font-mono text-xs text-muted">completion: {section.value}</p>;
  }
  return (
    <div className="frame rounded-sm border border-line bg-panel/60 px-4 py-4">
      <p className="mb-3 font-mono text-[11px] tracking-widest text-faint uppercase">Goal items</p>
      <ul className="space-y-3">
        {items.map((item, i) => {
          const done = threshold === undefined || item.value >= threshold;
          return (
            <li key={i} className="grid grid-cols-[4.5rem_1fr] items-center gap-3">
              <div className="grid gap-1">
                <span className={`font-mono text-xs ${done ? "text-pass" : "text-amend"}`}>
                  {item.value.toFixed(2)}
                </span>
                <Bar value={item.value} threshold={threshold} tone={done ? "bg-pass" : "bg-amend"} />
              </div>
              <span className="text-sm text-muted">{item.text}</span>
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

function Bar({
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
