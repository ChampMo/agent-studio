/**
 * Every round's plan, and what became of it.
 *
 * A continued run appends to one log, so each round's plan is still in it —
 * its tasks, what it was asked, and how it ended. Nothing is stored for this
 * and nothing should be: a second place saying what a round planned is a
 * second place to be wrong (§2.1).
 *
 * Under the budget block rather than beside the current plan, because these
 * are two different questions. The panel at the top answers *where are we*;
 * this answers *what happened before*, which is a thing you go and look for
 * rather than something that should be in the way while a run is going. It is
 * a picker for that reason too — one round at a time, rather than every round
 * stacked down a 316px column.
 *
 * Absent entirely on a run with one round. There is no history yet, and a
 * control that only ever says "Round 1" is a row that teaches the reader the
 * bottom of this column is not worth looking at — the argument that took the
 * layout id off the team cards.
 */
import { useState } from "react";

import { Menu } from "../../components/ui/Menu";
import { missionLook } from "../../components/ui/status";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useEventStore } from "../../stores/eventStore";
import { planRounds, type TaskState } from "./plan";

const MARK: Record<TaskState, string> = {
  done: "bg-done",
  running: "bg-search",
  failed: "bg-stop",
  pending: "bg-line",
};

const TONE: Record<string, string> = {
  done: "text-done",
  stop: "text-stop",
  wait: "text-wait",
  search: "text-search",
  idle: "text-faint",
};

export function PlanHistory() {
  const events = useEventStore((s) => s.events);
  const rounds = planRounds(events);
  // Default to the newest, which is the one a person is most likely to want
  // and the only one that needs no thought to find.
  const [picked, setPicked] = useState<number | null>(null);

  if (rounds.length < 2) return null;

  const round = rounds.find((r) => r.round === picked) ?? rounds[rounds.length - 1]!;
  // A round with no ending is the one still going; it has no `mission.ended`
  // to read a reason from, which is exactly what marks it.
  const look = round.endReason
    ? missionLook("ended", round.endReason, round.endLimit)
    : null;

  return (
    <section aria-label={strings.rail.plans}>
      <h3 className="flex items-baseline justify-between gap-2 px-1 pb-1.5">
        <span className="text-[11px] font-medium text-faint">{strings.rail.plans}</span>
        <Menu
          label={strings.rail.plans}
          selectedLabel={strings.rail.planRound(round.round)}
          triggerClassName={cn(
            "flex min-h-[24px] items-center gap-1 rounded-card px-1.5",
            "text-[11px] text-muted transition-colors hover:bg-solid hover:text-text",
          )}
          trigger={
            <>
              {strings.rail.planRound(round.round)}
              <svg viewBox="0 0 16 16" className="size-3 text-faint" aria-hidden>
                <path
                  d="M4 6.5 8 10.5 12 6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </>
          }
          items={rounds.map((r) => ({
            label: strings.rail.planRoundOf(r.round, r.done, r.tasks.length),
            // How it ended, in the words the rest of the app uses for an
            // ending — not a second vocabulary for the same thing.
            hint: r.endReason
              ? missionLook("ended", r.endReason, r.endLimit).label
              : strings.rail.planRoundNow,
            onSelect: () => setPicked(r.round),
          }))}
        />
      </h3>

      <div className="space-y-1.5 rounded-[9px] border border-line bg-solid-2 px-3 py-2.5">
        {look ? (
          <p className={cn("text-[11px]", TONE[look.tone] ?? "text-muted")}>
            {look.label}
          </p>
        ) : (
          <p className="text-[11px] text-faint">{strings.rail.planRoundNow}</p>
        )}

        {round.tasks.length === 0 ? (
          // The round that died in planning is exactly the one worth being
          // able to look at, so it gets a line rather than being left out.
          <p className="text-[11px] leading-snug text-faint">
            {strings.rail.planNoTasks}
          </p>
        ) : (
          <ol className="space-y-1">
            {round.tasks.map((task) => (
              <li key={task.id} className="flex items-start gap-2">
                <span
                  aria-hidden
                  className={cn("mt-1 size-1.5 shrink-0 rounded-full", MARK[task.state])}
                />
                <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
                  {task.title}
                </span>
              </li>
            ))}
          </ol>
        )}

        {round.asked ? (
          <p className="truncate pt-0.5 text-[11px] text-faint" title={round.asked}>
            {strings.rail.planAsked}: {round.asked}
          </p>
        ) : null}
      </div>
    </section>
  );
}
