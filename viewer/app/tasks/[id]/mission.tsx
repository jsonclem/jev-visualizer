"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { HistoryEvent, Kind, Task } from "@/lib/tasks";
import { clock, KIND_STYLE, StatusStamp } from "../../ui";
import { Evidence, num, parseCompletion, parseScope } from "./evidence";
import type { Mode, Stage } from "./stage";

const POLL_MS = 3000;
const REPLAY_SPEED = 3;
const SKIP_SPEED = 40;
// check.py stops and hands these back to the user.
const WAITING: Kind[] = ["block", "escalate", "reject", "stop"];

// After a pass whose completion was too large to check, the agent commits and
// then must ask the user whether the goal is complete (SKILL.md).
function waitingOnYou(history: HistoryEvent[]) {
  const last = history.at(-1);
  if (!last) return false;
  if (WAITING.includes(last.kind)) return true;
  if (last.kind !== "commit") return false;
  const pass = history.findLast((event) => event.kind === "pass");
  return !!pass && completionUnchecked(pass);
}

function completionUnchecked(event: HistoryEvent) {
  return /(^|\s)complete=unknown(\s|$)/.test(event.detail);
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
  const [replaying, setReplaying] = useState(initial.history.length > 0);
  const [speed, setSpeed] = useState(REPLAY_SPEED);
  const replayUntil = useRef(initial.history.length);
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

  // The director: plays each history event in order, fast for the replay,
  // then waits for new events from the poll.
  useEffect(() => {
    if (!stage) return;
    let alive = true;
    (async () => {
      let i = 0;
      while (alive) {
        const history = taskRef.current.history;
        if (i < history.length) {
          const replay = i < replayUntil.current;
          stage.setSpeed(!replay ? 1 : skipping.current ? SKIP_SPEED : REPLAY_SPEED);
          const show = (next: Overlay | null) => {
            if (alive && !(replay && skipping.current)) setOverlay(next);
          };
          await direct(stage, history[i], taskRef.current, show);
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

  const drained = played >= task.history.length;
  const last = task.history.at(-1);
  const needsYou = task.status === "active" && waitingOnYou(task.history);
  const mode: Mode =
    task.status === "complete"
      ? "complete"
      : task.status === "closed"
        ? "aborted"
        : needsYou
          ? "hold"
          : "cruise";

  useEffect(() => {
    if (stage && drained) stage.setMode(mode);
  }, [stage, drained, mode]);

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

  const shown = task.history.slice(0, played);

  return (
    <div className="grid min-h-screen lg:h-screen lg:grid-cols-[16rem_minmax(0,1fr)_19rem] xl:grid-cols-[20rem_minmax(0,1fr)_24rem] lg:overflow-hidden">
      <Objectives task={task} shown={shown} />

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

async function direct(stage: Stage, event: HistoryEvent, task: Task, show: (overlay: Overlay | null) => void) {
  const { COLOR } = await import("./stage");
  const section = (name: string) => event.sections.find((s) => s.name === name);
  const correction = section("correction")?.value.trim() ?? "";

  switch (event.kind) {
    case "init":
      show({ kind: "briefing", title: "Mission briefing", body: task.goal[0]?.text ?? "" });
      await stage.launch();
      await stage.wait(2600);
      show(null);
      return;
    case "resume":
      await stage.warpIn("SESSION RESUMED");
      return;
    case "pass":
    case "block":
    case "escalate": {
      const scope = section("scope");
      if (scope) {
        const { files, drifts } = parseScope(scope);
        const blockAt = num(task.config, "scope.block_verdict_confidence") ?? 0.6;
        const sureAt = num(task.config, "scope.min_verdict_confidence") ?? 0.5;
        const driftAt = num(task.config, "scope.drift_block") ?? 0.6;
        if (files.length) {
          await stage.cargo(
            files.map((file) => {
              const outside = file.verdict !== "within_scope";
              const refused = outside && file.confidence >= blockAt;
              const unsure = outside || file.confidence < sureAt;
              return {
                accepted: !refused,
                color: refused ? COLOR.block : unsure ? COLOR.amend : COLOR.pass,
              };
            }),
          );
        }
        if (drifts.length) {
          await stage.driftWave(
            drifts.map((drift) => ({
              label: DRIFT_LABEL[drift.name] ?? drift.name.replace(/^drift_/, ""),
              value: drift.value,
              tripped: drift.value >= driftAt,
            })),
          );
        }
      }
      if (event.kind === "pass") {
        await stage.warpRing();
        if (completionUnchecked(event)) await stage.ping("COMPLETION NOT CHECKED", COLOR.amend);
      }
      else if (event.kind === "block") await stage.forceField(blockReason(event.detail));
      else await stage.ping(escalateReason(event.detail), COLOR.amend);
      return;
    }
    case "commit": {
      const [sha, ...subject] = event.detail.split("  ");
      await stage.station(sha, subject.join("  ").replace(/ session=\S+$/, ""));
      return;
    }
    case "complete":
      await stage.planet();
      show({ kind: "banner", title: "Mission complete", tone: "pass" });
      await stage.wait(2800);
      show(null);
      return;
    case "amend":
      show({ kind: "comms", title: "Incoming transmission · Command", body: correction });
      await stage.wait(Math.min(9000, Math.max(3000, 1500 + correction.length * 28)));
      show(null);
      return;
    case "reject": {
      const notes = (section("clarity")?.items ?? [])
        .filter((item) => item.startsWith("- "))
        .map((item) => item.slice(2));
      show({ kind: "static", title: "Transmission rejected", body: [correction, ...notes].join("\n\n") });
      await stage.wait(3600);
      show(null);
      return;
    }
    case "accept":
      show({ kind: "comms", title: "Command acknowledged", body: event.detail.replace(/ session=\S+$/, "") });
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

function blockReason(detail: string) {
  const drift = /drift=(\S+)/.exec(detail);
  const outside = /outside_scope=(\S+)/.exec(detail);
  if (outside) return `OUTSIDE SCOPE · ${outside[1].split(",").map(basename).join(", ")}`;
  if (drift) return `DRIFT · ${drift[1].replace(/drift_/g, "").replace(/,/g, ", ").toUpperCase()}`;
  return "BLOCKED";
}

function escalateReason(detail: string) {
  const files = /files=(\S+)/.exec(detail);
  const tooLarge = /too-large file=(\S+)/.exec(detail);
  if (files) return `LOW CONFIDENCE · ${files[1].split(",").map(basename).join(", ")}`;
  if (tooLarge) return `TOO LARGE TO CHECK · ${basename(tooLarge[1])}`;
  if (detail.startsWith("diff-failed")) return "COULD NOT DIFF CHANGES";
  if (detail.startsWith("no-changes")) return "NO CHANGES TO CHECK";
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

  return (
    <div className="pointer-events-none absolute inset-0 font-mono text-[10px] tracking-[0.2em] uppercase">
      <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-3 text-muted">
        <span className="min-w-0 truncate">
          sector <span className="text-paper">{task.repo}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span>
            event <span className="text-paper">{String(played).padStart(2, "0")}</span>/
            {String(task.history.length).padStart(2, "0")}
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
      <div className="absolute inset-x-3 bottom-3 text-center">
        {mode === "hold" && (
          <span className="blink inline-block rounded border border-amend/60 bg-ink/70 px-3 py-1.5 text-amend">
            ⚠ awaiting command · needs you
          </span>
        )}
        {mode === "cruise" && (
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

function Objectives({ task, shown }: { task: Task; shown: HistoryEvent[] }) {
  const threshold = num(task.config, "completion.item_complete") ?? 0.85;
  const latest = [...shown].reverse().find((event) => {
    const section = event.sections.find((s) => s.name === "completion");
    return section && parseCompletion(section).length > 0;
  });
  const scores = latest ? parseCompletion(latest.sections.find((s) => s.name === "completion")!) : [];
  const latestPass = shown.findLast((event) => event.kind === "pass");
  const unchecked = !!latestPass && latestPass !== latest && completionUnchecked(latestPass);
  const done = task.objectives.filter((_, i) => (scores[i]?.value ?? 0) >= threshold).length;
  const [original, ...corrections] = task.goal;

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
        </div>
        <h1 className="glow mt-3 font-display text-2xl leading-tight font-semibold tracking-wide">{task.title}</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <p className="flex items-baseline justify-between font-display text-[11px] font-semibold tracking-[0.25em] text-info uppercase">
          <span className="glow">▸ Objectives</span>
          <span>
            <span className={done === task.objectives.length ? "text-pass" : "text-paper"}>{done}</span>/
            {task.objectives.length}
          </span>
        </p>
        {unchecked ? (
          <p className="mt-2 text-xs text-amend">
            Not checked on the latest pass: the change was too large to score.
            {latest && ` Scores below are from ${clock(latest.at)}.`}
          </p>
        ) : (
          !latest && <p className="mt-2 text-xs text-muted">Scores arrive with the first passed gate.</p>
        )}
        <ol className="mt-4 space-y-3.5">
          {task.objectives.map((objective, i) => {
            const value = scores[i]?.value;
            const complete = value !== undefined && value >= threshold;
            return (
              <li key={i} className="grid grid-cols-[1rem_1fr] gap-2">
                <span className={`font-mono text-xs ${complete ? "text-pass" : "text-faint"}`}>
                  {complete ? "✓" : "◇"}
                </span>
                <div className="min-w-0">
                  <p className={`line-clamp-2 text-[13px] leading-snug ${complete ? "text-paper" : "text-muted"}`}>
                    {objective}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="relative h-1.5 flex-1">
                      <div className="segments absolute inset-0 bg-line">
                        <div
                          className={`absolute inset-y-0 left-0 transition-[width] duration-700 ${complete ? "bg-pass" : "bg-amend"}`}
                          style={{ width: `${(value ?? 0) * 100}%` }}
                        />
                      </div>
                      <div
                        className="absolute -inset-y-0.5 w-px bg-paper/50"
                        style={{ left: `${threshold * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right font-mono text-[10px] text-faint">
                      {value === undefined ? "--" : value.toFixed(2)}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <details className="mt-8 border-t border-line pt-4">
          <summary className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase hover:text-paper">
            <span className="chevron mr-2 inline-block transition-transform">›</span>
            Full briefing
          </summary>
          <p className="mt-3 text-[13px] leading-relaxed whitespace-pre-wrap text-paper/90">{original?.text}</p>
          {corrections.map((correction, i) => (
            <div key={i} className="mt-4 border-l-2 border-amend pl-3">
              <p className="font-mono text-[10px] tracking-[0.2em] text-amend uppercase">
                Correction {correction.at && `· ${clock(correction.at)}`}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{correction.text}</p>
            </div>
          ))}
        </details>
      </div>
    </aside>
  );
}

function FlightLog({ shown, config }: { shown: HistoryEvent[]; config: Task["config"] }) {
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
              {event.sections.length > 0 && (
                <details className="mt-1.5">
                  <summary className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase hover:text-paper">
                    <span className="chevron mr-1.5 inline-block transition-transform">›</span>
                    evidence
                  </summary>
                  <Evidence sections={event.sections} config={config} />
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function Detail({ event }: { event: HistoryEvent }) {
  if (event.kind === "commit") {
    const [sha, ...subject] = event.detail.split("  ");
    return (
      <p className="mt-0.5">
        <code className="font-mono text-[11px] text-faint">{sha}</code>{" "}
        <span className="font-display text-[15px] leading-tight">{subject.join("  ")}</span>
      </p>
    );
  }
  const pairs = event.detail
    .split(/\s+/)
    .flatMap((token) => {
      const match = /^(\w+)=(.+)$/.exec(token);
      return match ? [[match[1], match[2]] as const] : [];
    });
  const words = event.detail
    .split(/\s+/)
    .filter((token) => token && !/^\w+=/.test(token))
    .join(" ");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
      {words && <span>{words}</span>}
      {pairs.map(([key, value]) => (
        <span
          key={key}
          className="inline-flex max-w-full items-baseline gap-1 rounded border border-line px-1.5 py-px font-mono text-[10px]"
        >
          <span className="text-faint">{key}</span>
          <span className={`break-all ${key === "drift" || key === "outside_scope" ? "text-block" : "text-paper"}`}>
            {value.split(",").join(", ")}
          </span>
        </span>
      ))}
    </div>
  );
}
