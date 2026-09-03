/**
 * The plan, and where it has got to.
 *
 * `mission.progress` fires for every task at every state change, and the
 * timeline printed each one as a centred line — five `pending 0/5` rows
 * directly under a plan message that had just listed the same five tasks. True,
 * duplicated, and it pushed the run's actual content off the screen.
 *
 * A task's state is not history. It is **where things stand**, which is what a
 * panel is for and what a log is not — the same argument that moved agent
 * status out of the stream. So those rows fold away with the rest of the
 * background, and this answers the question they were answering badly.
 */
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useEventStore } from "../../stores/eventStore";
import { planProgress, type TaskState } from "./plan";

const MARK: Record<TaskState, string> = {
  done: "bg-done",
  running: "bg-search",
  failed: "bg-stop",
  pending: "bg-line",
};

export function PlanProgress() {
  const events = useEventStore((s) => s.events);
  const plan = planProgress(events);
  if (plan.tasks.length === 0) return null;

  return (
    <section aria-label={strings.rail.plan}>
      <h3 className="flex items-baseline justify-between gap-2 px-1 pb-1.5">
        <span className="text-[11px] font-medium text-faint">{strings.rail.plan}</span>
        <span className="text-[11px] text-faint tabular-nums">
          {strings.rail.planDone(plan.done, plan.tasks.length)}
        </span>
      </h3>

      {/* One segment per task, in the plan's own order. Not a percentage: a
          plan of five tasks is five things, and "40%" would be a number
          invented from them (§1.1). */}
      <div className="flex gap-0.5 px-1 pb-2" aria-hidden>
        {plan.tasks.map((task) => (
          <span
            key={task.id}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              MARK[task.state],
              task.state === "running" && "animate-pulse",
            )}
          />
        ))}
      </div>

      <ul className="space-y-0.5">
        {plan.tasks.map((task) => (
          <li
            key={task.id}
            className="flex items-baseline gap-2 rounded-card px-1 py-0.5 text-[11px]"
          >
            <span
              className={cn("mt-1 size-1.5 shrink-0 rounded-full", MARK[task.state])}
              aria-hidden
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                task.state === "done" && "text-faint",
                task.state === "running" && "text-text",
                task.state === "failed" && "text-stop",
                task.state === "pending" && "text-muted",
              )}
            >
              {task.title}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
