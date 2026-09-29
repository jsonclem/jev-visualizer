"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Kind, ObjectiveRecord, Task, TaskEvent, VerifyRecord } from "@/lib/tasks";
import { clock, KIND_STYLE, StatusStamp } from "../../ui";
import { Bar, Evidence, hasEvidence, num, OBJECTIVE_MARK, VERIFY_MARK } from "./evidence";
import type { Mode, Stage } from "./stage";

const POLL_MS = 3000;
const REPLAY_SPEED = 3;
const SKIP_SPEED = 40;
// check.py stops and hands these back to the user.
const WAITING: Kind[] = ["block", "escalate", "reject", "stop"];

// check.py's NEXT line says when the agent must stop and ask.
function waitingOnYou(task: Task) {
  if (task.next?.startsWith("ask the user")) return true;
  const last = task.events.at(-1);
  return !!last && WAITING.includes(last.kind);
}

type Overlay =
  | { kind: "briefing" | "comms"; title: string; body: string }
  | { kind: "static"; title: string; body: string }
  | { kind: "banner"; title: string; tone: "pass" | "muted" };

export function Mission({ initial }: { initial: Task }) {
  const [task, setTask] = useState(initial);
  const taskRef = useRef(initial);
  const hostRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [played, setPlayed] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [replaying, setReplaying] = useState(initial.events.length > 0);
  const [speed, setSpeed] = useState(REPLAY_SPEED);
  const replayUntil = useRef(initial.events.length);
  const skipping = useRef(false);

  // Live updates: re-read the task folder every few seconds.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(initial.id)}`, { cache: "no-store" });
        if (!res.ok) return;
        const next: Task = await res.json();
        taskRef.current = next;
        setTask(next);
      } catch {
        // The dev server restarting is not worth surfacing; the next poll retries.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [initial.id]);

  useEffect(() => {
    let alive = true;
    let made: Stage | null = null;
    (async () => {
      const { Stage } = await import("./stage");
      await document.fonts.ready;
      const font =
        getComputedStyle(document.documentElement).getPropertyValue("--font-share-tech-mono").trim() || "monospace";
      if (!alive || !hostRef.current) return;
      const created = await Stage.create(hostRef.current, font);
      if (!alive) return created.destroy();
      made = created;
      setStage(created);
    })();
    return () => {
      alive = false;
      made?.destroy();
    };
  }, []);

  // The director: plays each event in order, fast for the replay, then waits
  // for new events from the poll.
  useEffect(() => {
    if (!stage) return;
    let alive = true;
    (async () => {
      let i = 0;
      while (alive) {
        const events = taskRef.current.events;
        if (i < events.length) {
          const replay = i < replayUntil.current;
          stage.setSpeed(!replay ? 1 : skipping.current ? SKIP_SPEED : REPLAY_SPEED);
          const show = (next: Overlay | null) => {
            if (alive && !(replay && skipping.current)) setOverlay(next);
          };
          await direct(stage, events, i, taskRef.current, show);
          if (!alive) return;
          i += 1;
          setPlayed(i);
        } else {
          stage.setSpeed(1);
          setReplaying(false);
          setSpeed(1);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [stage]);

  const drained = played >= task.events.length;
  const last = task.events.at(-1);
  const needsYou = task.status === "active" && waitingOnYou(task);
  const mode: Mode =
    task.status === "complete"
      ? "complete"
      : task.status === "closed"
        ? "aborted"
        : needsYou
          ? "hold"
          : "cruise";

  useEffect(() => {
    if (stage && drained && task.status !== "ready") stage.setMode(mode);
  }, [stage, drained, mode, task.status]);

  // The tab title follows the polled task, not the animation, so it still
  // changes while the tab is in the background and animations are paused.
  // Re-applied on every poll because Next streams its own <title> after load.
  useEffect(() => {
    document.title = needsYou ? `⚠ Needs you · ${task.title}` : `${task.title} · Task History`;
  }, [needsYou, task]);

  const skip = () => {
    skipping.current = true;
    setSpeed(SKIP_SPEED);
    setOverlay(null);
    stage?.setSpeed(SKIP_SPEED);
  };

  const shown = task.events.slice(0, played);

  return (
    <div className="grid min-h-screen lg:h-screen lg:grid-cols-[18rem_minmax(0,1fr)_19rem] xl:grid-cols-[22rem_minmax(0,1fr)_24rem] lg:overflow-hidden">
      <Objectives task={task} shown={shown} drained={drained} />

      <section className="relative order-first h-[72vh] border-line lg:order-none lg:h-auto lg:border-x">
        <div className="playfield relative mx-auto h-full max-w-[560px] overflow-hidden border-x border-info/15">
          <div ref={hostRef} className="absolute inset-0" />
          <div className="scanlines pointer-events-none absolute inset-0" />
          <Hud
            task={task}
            played={played}
            replaying={replaying}
            speed={speed}
            onSkip={skip}
            mode={drained ? mode : null}
            lastAt={last?.at ?? task.created}
          />
          {overlay && <OverlayView overlay={overlay} speed={speed} />}
        </div>
      </section>

      <FlightLog shown={shown} config={task.config} />
    </div>
  );
}

// Objectives met at this gate that were not met at the previous one.
function newlyMet(events: TaskEvent[], i: number) {
  const now = events[i].objectives ?? {};
  const before = events.slice(0, i).findLast((event) => event.objectives)?.objectives ?? {};
  return Object.entries(now)
    .filter(([id, record]) => record.state === "met" && before[id]?.state !== "met")
    .map(([id]) => id);
}

async function direct(
  stage: Stage,
  events: TaskEvent[],
  i: number,
  task: Task,
  show: (overlay: Overlay | null) => void,
) {
  const { COLOR } = await import("./stage");
  const event = events[i];

  switch (event.kind) {
    case "record": {
      const goal = task.goal;
      const lines = goal?.objectives.map((o) => `${o.id}  ${o.title || o.text.split("\n")[0]}`) ?? [];
      show({ kind: "briefing", title: `Mission briefing · ${goal?.title ?? task.title}`, body: lines.join("\n") });
      await stage.wait(2600);
      show(null);
      return;
    }
    case "start":
      await stage.launch();
      return;
    case "resume":
      await stage.warpIn("SESSION RESUMED");
      return;
    case "pass":
    case "block":
    case "escalate": {
      const blockAt = num(task.config, "scope.block_verdict_confidence") ?? 0.6;
      const sureAt = num(task.config, "scope.min_verdict_confidence") ?? 0.5;
      const driftAt = num(task.config, "scope.drift_block") ?? 0.6;
      if (event.scope?.length) {
        await stage.cargo(
          event.scope.map((file) => {
            const outside = file.verdict !== "within_scope";
            const refused = outside && file.confidence >= blockAt;
            const unsure = outside || file.confidence < sureAt;
            return { accepted: !refused, color: refused ? COLOR.block : unsure ? COLOR.amend : COLOR.pass };
          }),
        );
      }
      if (event.drift) {
        await stage.driftWave(
          Object.entries(event.drift).map(([name, value]) => ({
            label: DRIFT_LABEL[name] ?? name.replace(/^drift_/, ""),
            value,
            tripped: value >= driftAt,
          })),
        );
      }
      if (event.kind === "pass") {
        await stage.warpRing();
        const met = newlyMet(events, i);
        if (met.length) {
          await stage.cargo(met.map(() => ({ accepted: true, color: COLOR.pass })));
          await stage.ping(`${met.join(" ")} MET`, COLOR.pass);
        }
        const unchecked = Object.entries(event.objectives ?? {}).filter(([, r]) => r.state === "unchecked");
        if (unchecked.length) await stage.ping(`${unchecked.map(([id]) => id).join(" ")} NOT CHECKABLE`, COLOR.amend);
        const verify = Object.entries(event.verify ?? {});
        const failed = verify.filter(([, r]) => r.state === "failed").map(([id]) => id);
        const stuck = verify.filter(([, r]) => r.state === "couldnt_run").map(([id]) => id);
        if (failed.length) await stage.ping(`${failed.join(" ")} FAILED`, COLOR.block);
        if (stuck.length) await stage.ping(`${stuck.join(" ")} COULDN'T RUN`, COLOR.amend);
      } else if (event.kind === "block") await stage.forceField(blockReason(event));
      else await stage.ping(escalateReason(event), COLOR.amend);
      return;
    }
    case "commit":
      await stage.station(Object.values(event.shas ?? {}).join(" "), event.subject ?? "");
      return;
    case "complete":
      await stage.planet();
      show({ kind: "banner", title: "Mission complete", tone: "pass" });
      await stage.wait(2800);
      show(null);
      return;
    case "revise": {
      const body = (event.changes ?? []).join("\n");
      show({ kind: "comms", title: `Goal revised · version ${event.version}`, body });
      await stage.wait(Math.min(6000, 2000 + body.length * 28));
      show(null);
      return;
    }
    case "reject":
      show({ kind: "static", title: "Revision rejected", body: (event.changes ?? []).join("\n") });
      await stage.wait(3600);
      show(null);
      return;
    case "accept":
      show({ kind: "comms", title: "Config accepted", body: (event.changes ?? []).join("\n") });
      await stage.wait(2400);
      show(null);
      return;
    case "close":
      await stage.abort();
      show({ kind: "banner", title: "Mission aborted", tone: "muted" });
      await stage.wait(2400);
      show(null);
      return;
    case "stop":
      await stage.alert(event.event === "goal-changed" ? "GOAL EDITED BY HAND" : "CONFIG CHANGED");
      return;
    default:
      await stage.ping(event.event.toUpperCase(), COLOR.muted);
  }
}

const DRIFT_LABEL: Record<string, string> = {
  drift_refactor: "refactor",
  drift_deps: "deps",
  drift_tests_docs: "tests",
  drift_behavior: "behavior",
  drift_substitute: "subst",
};

function blockReason(event: TaskEvent) {
  if (event.uncovered?.length) return `NOT IN ANY FILES LINE · ${event.uncovered.map(basename).join(", ")}`;
  if (event.blocked?.length) return `OUTSIDE SCOPE · ${event.blocked.map(basename).join(", ")}`;
  const tripped = Object.keys(event.tripped ?? {});
  if (tripped.length) return `DRIFT · ${tripped.map((k) => k.replace(/^drift_/, "")).join(", ").toUpperCase()}`;
  return "BLOCKED";
}

function escalateReason(event: TaskEvent) {
  if (event.unsure?.length) return `LOW CONFIDENCE · ${event.unsure.map(basename).join(", ")}`;
  if (event.verify_changed?.length) return `VERIFY CHANGED FILES · ${event.verify_changed.map(basename).join(", ")}`;
  if (event.reason === "no-changes") return "NO CHANGES TO CHECK";
  return "ESCALATED";
}

function basename(path: string) {
  return path.split("/").at(-1) ?? path;
}

function Hud({
  task,
  played,
  replaying,
  speed,
  onSkip,
  mode,
  lastAt,
}: {
  task: Task;
  played: number;
  replaying: boolean;
  speed: number;
  onSkip: () => void;
  mode: Mode | null;
  lastAt: string | null;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, []);
  const next = mode && (task.status === "active" || task.status === "ready") ? task.next : null;

  return (
    <div className="pointer-events-none absolute inset-0 font-mono text-[10px] tracking-[0.2em] uppercase">
      <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-3 text-muted">
        <span className="min-w-0 truncate">
          sector <span className="text-paper">{task.repo}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span>
            event <span className="text-paper">{String(played).padStart(2, "0")}</span>/
            {String(task.events.length).padStart(2, "0")}
          </span>
          {replaying && (
            <button
              type="button"
              onClick={onSkip}
              className="pointer-events-auto rounded border border-info/50 px-2 py-0.5 whitespace-nowrap text-info hover:bg-info/10"
            >
              replay ×{speed} · skip
            </button>
          )}
        </span>
      </div>
      <div className="absolute inset-x-3 bottom-3 grid justify-items-center gap-2 text-center">
        {next && (
          <p
            className={`max-w-full rounded border bg-ink/80 px-3 py-1.5 tracking-[0.12em] normal-case ${
              mode === "hold" ? "border-amend/60 text-amend" : "border-info/40 text-info"
            }`}
          >
            <span className="mr-2 tracking-[0.2em] uppercase opacity-70">next</span>
            {next}
          </p>
        )}
        {mode === "hold" && (
          <span className="blink inline-block rounded border border-amend/60 bg-ink/70 px-3 py-1.5 text-amend">
            ⚠ awaiting command · needs you
          </span>
        )}
        {mode === "cruise" && task.status === "ready" && (
          <span className="text-info">goal recorded · waiting for check.py --start</span>
        )}
        {mode === "cruise" && task.status !== "ready" && (
          <span className="text-muted">
            last transmission{" "}
            <span className="text-paper">{now && lastAt ? since(now, lastAt) : "--"}</span> ago
          </span>
        )}
        {mode === "complete" && <span className="text-pass">mission complete</span>}
        {mode === "aborted" && <span className="text-muted">mission aborted · returned to base</span>}
      </div>
    </div>
  );
}

function since(now: number, at: string) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

function OverlayView({ overlay, speed }: { overlay: Overlay; speed: number }) {
  if (overlay.kind === "banner") {
    return (
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <p
          className={`rise glow font-display text-3xl font-bold tracking-[0.12em] uppercase sm:text-4xl ${overlay.tone === "pass" ? "text-pass" : "text-muted"}`}
        >
          {overlay.title}
        </p>
      </div>
    );
  }
  if (overlay.kind === "briefing") {
    return (
      <div className="pointer-events-none absolute inset-x-4 top-20 rise">
        <div className="frame rounded-sm border border-info/40 bg-ink/85 p-4 backdrop-blur-sm">
          <p className="font-display text-[11px] font-semibold tracking-[0.25em] text-info uppercase">{overlay.title}</p>
          <p className="mt-2 line-clamp-[10] text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-paper/90">
            <Typewriter key={overlay.body} text={overlay.body} cps={220 * speed} />
          </p>
        </div>
      </div>
    );
  }
  if (overlay.kind === "static") {
    return (
      <div className="pointer-events-none absolute inset-x-4 bottom-12 rise">
        <div className="frame static-noise relative overflow-hidden rounded-sm border border-block/50 bg-ink/90 p-4 [--frame:var(--color-block)]">
          <p className="glitch font-display text-[11px] font-semibold tracking-[0.25em] text-block uppercase">{overlay.title}</p>
          <p className="mt-2 line-clamp-6 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-paper/60">
            {overlay.body}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-12 rise">
      <div className="frame rounded-sm border border-amend/50 bg-ink/85 p-4 backdrop-blur-sm [--frame:var(--color-amend)]">
        <p className="font-display text-[11px] font-semibold tracking-[0.25em] text-amend uppercase">
          <span className="blink mr-2 inline-block">●</span>
          {overlay.title}
        </p>
        <p className="mt-2 line-clamp-8 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
          <Typewriter key={overlay.body} text={overlay.body} cps={70 * speed} />
        </p>
      </div>
    </div>
  );
}

function Typewriter({ text, cps }: { text: string; cps: number }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const step = Math.max(1, Math.round(cps / 30));
    const timer = setInterval(() => setCount((n) => Math.min(text.length, n + step)), 33);
    return () => clearInterval(timer);
  }, [text, cps]);
  return (
    <>
      {text.slice(0, count)}
      {count < text.length && <span className="text-amend">▌</span>}
    </>
  );
}

// During the replay the panel follows the events shown so far; once caught up
// it shows state.json, which also reflects goal revisions.
function records(task: Task, shown: TaskEvent[], drained: boolean) {
  if (drained) return { objectives: task.objectives, verify: task.verify };
  const gate = shown.findLast((event) => event.objectives);
  return { objectives: gate?.objectives ?? {}, verify: gate?.verify ?? {} };
}

function Objectives({ task, shown, drained }: { task: Task; shown: TaskEvent[]; drained: boolean }) {
  const threshold = num(task.config, "completion.item_complete") ?? 0.85;
  const goal = task.goal;
  const current = records(task, shown, drained);
  const objectives = goal?.objectives ?? [];
  const checks = goal?.verify ?? [];
  const multi = (goal?.repos.length ?? 0) > 1;
  const met = objectives.filter((o) => current.objectives[o.id]?.state === "met").length;
  const passed = checks.filter((c) => current.verify[c.id]?.state === "passed").length;
  const versions = task.events.filter((event) => event.kind === "record" || event.kind === "revise");

  return (
    <aside className="flex min-h-0 flex-col border-t border-line bg-panel/35 lg:border-t-0">
      <div className="border-b border-line px-5 py-5">
        <Link
          href="/"
          className="font-mono text-[10px] tracking-[0.2em] text-muted uppercase transition-colors hover:text-info"
        >
          ← All tasks
        </Link>
        <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
          <StatusStamp status={task.status} />
          <span title={task.repoPath}>{task.repo}</span>
          {goal && <span>v{goal.version}</span>}
        </div>
        <h1 className="glow mt-3 font-display text-2xl leading-tight font-semibold tracking-wide">{task.title}</h1>
        {goal?.summary && <p className="mt-2 text-[13px] leading-snug text-muted">{goal.summary}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <PanelHeading label="Objectives" done={met} total={objectives.length} />
        <ol className="mt-4 space-y-4">
          {objectives.map((objective) => (
            <ObjectiveRow
              key={objective.id}
              id={objective.id}
              title={objective.title}
              text={objective.text}
              files={objective.files}
              record={current.objectives[objective.id] ?? { state: "pending" }}
              threshold={threshold}
            />
          ))}
        </ol>

        <div className="mt-8">
          <PanelHeading label="Verify" done={passed} total={checks.length} />
          <ol className="mt-4 space-y-3.5">
            {checks.map((check) => (
              <VerifyRow
                key={check.id}
                id={check.id}
                command={check.command}
                requires={check.requires}
                repo={multi ? check.repo : ""}
                record={current.verify[check.id] ?? { state: "pending" }}
                log={drained ? task.logs[check.id] : undefined}
              />
            ))}
          </ol>
        </div>

        {goal && (goal.rules.length > 0 || goal.out_of_scope.length > 0) && (
          <details className="mt-8 border-t border-line pt-4">
            <summary className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase hover:text-paper">
              <span className="chevron mr-2 inline-block transition-transform">›</span>
              Rules · out of scope
            </summary>
            <ul className="mt-3 space-y-2 text-[13px] leading-snug">
              {goal.rules.map((rule) => (
                <li key={rule.id} className="grid grid-cols-[2rem_1fr] gap-1">
                  <span className="font-mono text-xs text-info">{rule.id}</span>
                  <span className="text-paper/90">{rule.text}</span>
                </li>
              ))}
              {goal.out_of_scope.map((item) => (
                <li key={item.id} className="grid grid-cols-[2rem_1fr] gap-1">
                  <span className="font-mono text-xs text-block/80">{item.id}</span>
                  <span className="text-muted">{item.text}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {versions.length > 0 && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase hover:text-paper">
              <span className="chevron mr-2 inline-block transition-transform">›</span>
              Goal versions · {versions.length}
            </summary>
            <ol className="mt-3 space-y-2 font-mono text-xs">
              {versions.map((event) => (
                <li key={event.at + event.version}>
                  <span className="text-paper">v{event.version}</span>{" "}
                  <span className="text-faint">{clock(event.at)}</span>
                  <p className="text-muted">{event.kind === "record" ? "recorded" : (event.changes ?? []).join(", ")}</p>
                </li>
              ))}
            </ol>
          </details>
        )}

        <details className="mt-4 border-t border-line pt-4">
          <summary className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase hover:text-paper">
            <span className="chevron mr-2 inline-block transition-transform">›</span>
            Full goal
          </summary>
          <pre className="mt-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-paper/90">
            {task.goalText}
          </pre>
        </details>
      </div>
    </aside>
  );
}

function PanelHeading({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <p className="flex items-baseline justify-between font-display text-[11px] font-semibold tracking-[0.25em] text-info uppercase">
      <span className="glow">▸ {label}</span>
      <span>
        <span className={total && done === total ? "text-pass" : "text-paper"}>{done}</span>/{total}
      </span>
    </p>
  );
}

function ObjectiveRow({
  id,
  title,
  text,
  files,
  record,
  threshold,
}: {
  id: string;
  title: string;
  text: string;
  files: string[];
  record: ObjectiveRecord;
  threshold: number;
}) {
  const mark = OBJECTIVE_MARK[record.state];
  const unchecked = record.state === "unchecked";
  return (
    <li className="grid grid-cols-[1rem_1fr] gap-2">
      <span className={`font-mono text-xs ${mark.text}`} title={mark.label}>
        {mark.mark}
      </span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2">
          <span className={`font-mono text-xs ${mark.text}`}>{id}</span>
          {title && <span className="truncate text-[13px] font-medium text-paper">{title}</span>}
        </p>
        <p
          className={`mt-0.5 line-clamp-3 text-[13px] leading-snug ${record.state === "met" ? "text-paper/90" : "text-muted"}`}
          title={text}
        >
          {text}
        </p>
        <p className="mt-1 truncate font-mono text-[10px] text-faint" title={files.join(", ")}>
          {files.join(", ")}
        </p>
        {record.score !== undefined ? (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex-1">
              <Bar value={record.score} threshold={threshold} tone={record.state === "met" ? "bg-pass" : "bg-amend"} />
            </div>
            <span className={`w-8 text-right font-mono text-[10px] ${mark.text}`}>{record.score.toFixed(2)}</span>
          </div>
        ) : (
          <p
            className={`mt-1.5 px-2 py-1 font-mono text-[10px] ${
              unchecked ? "hatched border border-muted/40 text-muted" : "text-faint"
            }`}
          >
            {mark.label}
            {record.reason ? ` · ${record.reason}` : ""}
          </p>
        )}
      </div>
    </li>
  );
}

function VerifyRow({
  id,
  command,
  requires,
  repo,
  record,
  log,
}: {
  id: string;
  command: string;
  requires: string;
  repo: string;
  record: VerifyRecord;
  log?: string;
}) {
  const mark = VERIFY_MARK[record.state];
  return (
    <li className="grid grid-cols-[1rem_1fr] gap-2">
      <span className={`font-mono text-xs ${mark.text}`} title={mark.label}>
        {mark.mark}
      </span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2">
          <span className={`font-mono text-xs ${mark.text}`}>{id}</span>
          <code className="truncate font-mono text-[11px] text-paper" title={command}>
            {command}
          </code>
        </p>
        {repo && <p className="truncate font-mono text-[10px] text-faint">in {repo}</p>}
        {requires && (
          <p className="truncate font-mono text-[10px] text-faint" title={requires}>
            requires {requires}
          </p>
        )}
        <p
          className={`mt-1 px-2 py-1 font-mono text-[10px] ${
            record.state === "couldnt_run" ? "hatched border border-muted/40" : ""
          } ${mark.text}`}
        >
          {mark.label}
          {record.state === "passed" && record.seconds !== undefined ? ` · ${record.seconds}s` : ""}
          {record.reason && record.state !== "passed" ? ` · ${record.reason}` : ""}
        </p>
        {log && (
          <details className="mt-1">
            <summary className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase hover:text-paper">
              <span className="chevron mr-1.5 inline-block transition-transform">›</span>
              log
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded-sm border border-line bg-ink/70 p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap text-muted">
              {log}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

function FlightLog({ shown, config }: { shown: TaskEvent[]; config: Task["config"] }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [shown.length]);

  return (
    <aside className="flex min-h-0 flex-col border-t border-line bg-panel/35 lg:border-t-0">
      <p className="glow border-b border-line px-5 py-4 font-display text-[11px] font-semibold tracking-[0.25em] text-info uppercase">
        ▸ Flight log
      </p>
      <ol ref={listRef} className="relative min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {shown.length === 0 && <li className="text-sm text-muted">Waiting for the first event…</li>}
        {shown.map((event, i) => {
          const style = KIND_STYLE[event.kind];
          return (
            <li key={i} className="rise relative pl-5">
              <span className={`absolute top-1.5 left-0 size-2 rounded-full ${style.bg}`} />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <time className="font-mono text-[11px] text-faint" dateTime={event.at}>
                  {clock(event.at)}
                </time>
                <span className={`text-sm font-medium ${style.text}`}>
                  {event.kind === "other" ? event.event : style.label}
                </span>
              </div>
              <Detail event={event} />
              {hasEvidence(event) && (
                <details className="mt-1.5">
                  <summary className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase hover:text-paper">
                    <span className="chevron mr-1.5 inline-block transition-transform">›</span>
                    evidence
                  </summary>
                  <Evidence event={event} config={config} />
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function Detail({ event }: { event: TaskEvent }) {
  if (event.kind === "commit") {
    const shas = Object.entries(event.shas ?? {});
    return (
      <p className="mt-0.5">
        <code className="font-mono text-[11px] text-faint">
          {shas.map(([name, sha]) => (shas.length > 1 ? `${name} ${sha}` : sha)).join(" · ")}
        </code>{" "}
        <span className="font-display text-[15px] leading-tight">{event.subject}</span>
      </p>
    );
  }
  const chips: [string, string, boolean?][] = [];
  if (event.version) chips.push(["version", String(event.version)]);
  if (event.base) chips.push(["base", Object.values(event.base).join(" · ")]);
  if (event.objectives) {
    const all = Object.values(event.objectives);
    chips.push(["met", `${all.filter((r) => r.state === "met").length}/${all.length}`]);
  }
  if (event.uncovered?.length) chips.push(["not in files", event.uncovered.join(", "), true]);
  if (event.blocked?.length) chips.push(["outside scope", event.blocked.join(", "), true]);
  if (event.tripped && Object.keys(event.tripped).length) chips.push(["drift", Object.keys(event.tripped).join(", "), true]);
  if (event.unsure?.length) chips.push(["unsure", event.unsure.join(", "), true]);
  if (event.verify_changed?.length) chips.push(["verify changed", event.verify_changed.join(", "), true]);
  if (event.reason) chips.push(["reason", event.reason]);
  return (
    <div className="mt-1 grid gap-1.5 text-xs text-muted">
      {event.detail && <span>{event.detail}</span>}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map(([key, value, bad]) => (
            <span
              key={key}
              className="inline-flex max-w-full items-baseline gap-1 rounded border border-line px-1.5 py-px font-mono text-[10px]"
            >
              <span className="text-faint">{key}</span>
              <span className={`break-all ${bad ? "text-block" : "text-paper"}`}>{value}</span>
            </span>
          ))}
        </div>
      )}
      {event.next && (
        <p className="font-mono text-[11px]">
          <span className="text-faint">next </span>
          <span className={event.next.startsWith("ask the user") ? "text-amend" : "text-info"}>{event.next}</span>
        </p>
      )}
    </div>
  );
}
