/**
 * What the last round did not finish, and one button that picks it all up.
 *
 * A round that stops early leaves its plan half-executed, and the only way to
 * carry on was to run the whole round again — paying for everything that
 * already succeeded in order to redo the part that did not. On the run this
 * came from, what was left was the UI review, the requirements audit and the
 * QA pass: the *verification* tasks, which are last in every plan, so they are
 * first to go every time, and they are the ones that would have said whether
 * the rest is true.
 *
 * **One button, not one per task.** A round each would be a round each: every
 * one re-reads the workspace and re-establishes what the others already know.
 * What is left over is a plan already — the tail of one the leader wrote — so
 * it goes back as a plan, in a single round.
 *
 * **And it resumes rather than re-asks.** The button used to send the tasks
 * back as a fresh instruction, which made the leader write a new plan from
 * them: on one measured run that produced five rounds which each re-planned
 * substantially the same five tasks, finished one or two, and never once
 * reached the verification tail — `docs/QA_REPORT.md` was planned four times
 * and never written. Nothing was wrong with the plan. There was never room
 * left to get to the end of it, and each round paid to write it out again.
 * `resumeRun` carries the plan instead, so a pause costs a limit and not a
 * planning turn.
 *
 * Directly above the composer, outside the scroll. It is a thing to decide, not
 * a thing that happened, so it does not belong in the record — and the record
 * is where it scrolls away. Two earlier placements were wrong in opposite
 * directions: in the rail it was a paragraph beside the numbers, where nobody
 * decides anything; under the composer it was unlabelled chips in a row of
 * controls, and the first question it got was what they were for.
 */
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useEventStore, type SequencedEntry } from "../../stores/eventStore";
import { useMissionStore } from "../../stores/missionStore";
import { useEndReason } from "../../stores/runState";
import { unfinishedTasks } from "./unfinished";

export function UnfinishedWork() {
  const events = useEventStore((s) => s.events);
  const missionId = useMissionStore((s) => s.missionId);
  const resumeRun = useMissionStore((s) => s.resumeRun);
  const launching = useMissionStore((s) => s.launching);
  const endReason = useEndReason();

  // Only once the round has stopped. While it is going the plan is still being
  // carried out, and offering to redo a task the team is about to reach would
  // be offering to run it twice.
  if (missionId === null || endReason === null) return null;

  const left: ReturnType<typeof unfinishedTasks> = unfinishedTasks(
    events as SequencedEntry[],
  );
  if (left.length === 0) return null;

  return (
    <section
      aria-label={strings.rail.unfinished}
      className={cn(
        "mx-3 mb-1 flex items-center gap-3 rounded-[9px]",
        "border border-line bg-solid-2 px-3 py-2",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text">{strings.rail.unfinishedLead(left.length)}</p>
        {/* Named, not counted. "3 tasks" is a number; the titles are what tell
            you whether you want them done. Truncated on one line because the
            ending directly above has just listed them in full. */}
        <p className="truncate text-[11px] text-faint">
          {left.map((task) => task.title).join(" · ")}
        </p>
        <p className="text-[11px] text-faint">{strings.rail.unfinishedHint}</p>
      </div>
      <button
        type="button"
        disabled={launching}
        onClick={() => void resumeRun()}
        className={cn(
          "flex min-h-[24px] shrink-0 items-center gap-1.5 rounded-card",
          "border border-line px-2.5 py-1.5 text-[11px] text-muted",
          "hover:bg-solid hover:text-text disabled:opacity-40",
        )}
      >
        <RetryIcon />
        {strings.rail.retryAll}
      </button>
    </section>
  );
}

/** An arrow going back round. Drawn rather than a character, so it inherits
 *  the button's colour and sits on the text baseline like the rest of them. */
function RetryIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-[13px] shrink-0" aria-hidden>
      <path
        d="M3 8a5 5 0 1 1 1.6 3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M3 4.5V8h3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
