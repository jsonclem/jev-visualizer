import Link from "next/link";
import { listTasks, TASKS_DIR } from "@/lib/tasks";
import { AutoRefresh } from "./auto-refresh";
import { ago, day, StatusStamp, Strip } from "./ui";

export const dynamic = "force-dynamic";

export default async function Home() {
  const tasks = await listTasks();
  const count = (status: string) => tasks.filter((task) => task.status === status).length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:px-8 sm:py-20">
      <AutoRefresh ms={4000} />
      <header className="rise mb-12 sm:mb-16">
        <p className="font-mono text-xs tracking-[0.3em] text-info uppercase">
          ▸ task-contract · flight recorder
        </p>
        <h1 className="mt-4 font-display text-5xl leading-none font-bold tracking-wide uppercase sm:text-7xl">
          Active <span className="glow text-info">Tasks</span>
        </h1>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs text-muted">
          <span className="truncate">{TASKS_DIR}</span>
          <span>
            <span className="text-info">{count("ready")}</span> ready ·{" "}
            <span className="text-amend">{count("active")}</span> in progress ·{" "}
            <span className="text-pass">{count("complete")}</span> complete ·{" "}
            <span className="text-paper">{count("closed")}</span> closed
          </span>
        </div>
      </header>

      {tasks.length === 0 ? (
        <p className="border-t border-line pt-8 text-muted">
          No tasks yet. Tasks appear here when task-contract creates them.
        </p>
      ) : (
        <ol className="border-b border-line">
          {tasks.map((task, i) => {
            const commits = task.events.filter((event) => event.kind === "commit").length;
            const objectives = task.goal?.objectives ?? [];
            const met = objectives.filter((o) => task.objectives[o.id]?.state === "met").length;
            return (
              <li
                key={task.id}
                className="rise border-t border-line"
                style={{ animationDelay: `${80 + i * 60}ms` }}
              >
                <Link
                  href={`/tasks/${encodeURIComponent(task.id)}`}
                  className="group -mx-4 grid gap-6 px-4 py-7 transition-colors hover:bg-panel/70 sm:-mx-6 sm:px-6 md:grid-cols-[1fr_15rem]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-muted">
                      <StatusStamp status={task.status} />
                      <span>{task.repo}</span>
                      {task.created && <span>{day(task.created)}</span>}
                    </div>
                    <h2 className="mt-3 font-display text-2xl leading-tight font-semibold tracking-wide transition-colors group-hover:text-info sm:text-3xl">
                      {task.title}
                    </h2>
                    <p className="mt-2 line-clamp-2 max-w-2xl text-sm leading-relaxed text-muted">
                      {task.goal?.summary || task.goal?.objectives[0]?.text}
                    </p>
                  </div>
                  <div className="flex flex-col justify-end gap-3 md:items-end">
                    <Strip history={task.events} />
                    <p className="font-mono text-xs text-muted">
                      <span className={objectives.length && met === objectives.length ? "text-pass" : "text-paper"}>
                        {met}/{objectives.length}
                      </span>{" "}
                      objectives · {commits} {commits === 1 ? "commit" : "commits"}
                    </p>
                    <p className="font-mono text-xs text-faint">
                      last activity {ago(task.lastAt)}
                      <span className="ml-2 inline-block transition-transform group-hover:translate-x-1">
                        →
                      </span>
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
