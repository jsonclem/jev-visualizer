import type { Kind, Status, TaskEvent } from "@/lib/tasks";

export const KIND_STYLE: Record<Kind, { label: string; text: string; bg: string }> = {
  record: { label: "Goal recorded", text: "text-info", bg: "bg-info" },
  start: { label: "Started", text: "text-info", bg: "bg-info" },
  resume: { label: "Resumed", text: "text-info", bg: "bg-info" },
  pass: { label: "Gate passed", text: "text-pass", bg: "bg-pass" },
  block: { label: "Gate blocked", text: "text-block", bg: "bg-block" },
  escalate: { label: "Escalated", text: "text-amend", bg: "bg-amend" },
  commit: { label: "Commit", text: "text-commit", bg: "bg-commit" },
  complete: { label: "Goal complete", text: "text-pass", bg: "bg-pass" },
  revise: { label: "Goal revised", text: "text-amend", bg: "bg-amend" },
  reject: { label: "Revision rejected", text: "text-block", bg: "bg-block" },
  accept: { label: "Config accepted", text: "text-info", bg: "bg-info" },
  close: { label: "Closed", text: "text-muted", bg: "bg-faint" },
  stop: { label: "Stopped", text: "text-block", bg: "bg-block" },
  other: { label: "Event", text: "text-muted", bg: "bg-muted" },
};

const STATUS_STYLE: Record<Status, { label: string; text: string; dot: string; live?: boolean }> = {
  ready: { label: "Ready", text: "text-info", dot: "bg-info" },
  active: { label: "In progress", text: "text-amend", dot: "bg-amend", live: true },
  complete: { label: "Complete", text: "text-pass", dot: "bg-pass" },
  closed: { label: "Closed", text: "text-muted", dot: "bg-faint" },
  unknown: { label: "Unknown", text: "text-muted", dot: "bg-faint" },
};

export function StatusStamp({ status }: { status: Status }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-2 bg-current/12 px-3.5 py-0.5 font-mono text-[11px] tracking-[0.18em] uppercase [clip-path:polygon(7px_0,100%_0,calc(100%-7px)_100%,0_100%)] ${style.text}`}
    >
      <span className="relative flex size-1.5">
        {style.live && (
          <span className={`absolute inset-0 animate-ping rounded-full opacity-75 ${style.dot}`} />
        )}
        <span className={`relative size-1.5 rounded-full ${style.dot}`} />
      </span>
      {style.label}
    </span>
  );
}

// One tick per history event, so a task's shape reads at a glance.
export function Strip({ history }: { history: TaskEvent[] }) {
  return (
    <div className="flex h-6 flex-wrap items-end gap-[3px]" aria-label={`${history.length} events`}>
      {history.map((event, i) => (
        <span
          key={i}
          title={`${KIND_STYLE[event.kind].label} · ${clock(event.at)}`}
          className={`w-[4px] rounded-[1px] ${KIND_STYLE[event.kind].bg} ${
            event.kind === "commit" || event.kind === "complete"
              ? "h-6"
              : event.kind === "block" || event.kind === "reject" || event.kind === "stop"
                ? "h-4"
                : "h-2.5 opacity-80"
          }`}
        />
      ))}
    </div>
  );
}

// Times are shown as check.py wrote them, in the task's own local offset.
export function clock(at: string) {
  return at.slice(11, 16);
}

export function day(at: string) {
  const [y, m, d] = at.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ago(at: string | null) {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
