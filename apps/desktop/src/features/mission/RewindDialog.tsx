/**
 * Choosing a point to put the files back to, and seeing what that would do
 * before agreeing to it.
 *
 * The plan is fetched and shown *first*, always. This can only restore what
 * `write_file` and `edit_file` wrote — a file `bash` created or moved has no
 * stored copy — and that limit decides whether the command is any use in a
 * given run. Discovering it afterwards, from a workspace that is half-restored
 * and half not, would be the worst possible way to learn it.
 *
 * Points come from the log rather than from a date picker: a run's own rounds
 * and plans are the moments anybody actually means by "before that went
 * wrong". Each is a real event with a real sequence number, so what is offered
 * is a list of things that happened (§1), not a timeline this build invented.
 */
import { useEffect, useMemo, useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/format";
import { Button } from "../../components/ui/primitives";
import { useEventStore, type SequencedEntry } from "../../stores/eventStore";
import { useMissionStore } from "../../stores/missionStore";
import { api, type RewindPlan } from "../../transport/rest";

interface Point {
  seq: number;
  label: string;
  ts: string | null;
}

/** The moments in a run worth going back to.
 *
 *  Deliberately few. Every event is addressable, and offering all 1,170 of
 *  them would be a list nobody can choose from — these are the ones a person
 *  means: where a round started, and where each task began. */
export function pointsFrom(events: SequencedEntry[]): Point[] {
  const out: Point[] = [];
  // The envelope nests the event under `draft` — reading `ev.type` gets
  // `undefined` and silently finds nothing, which is exactly how this first
  // came out empty over a run with 48 events on it.
  for (const { event } of events) {
    const type = event.draft.type;
    const p = event.draft.payload as unknown as Record<string, unknown>;
    const ts = event.ts ?? null;
    if (type === "user.message") {
      const content = String(p.content ?? "");
      out.push({
        seq: event.seq,
        label: content.slice(0, 70) || "a message",
        ts,
      });
    } else if (type === "mission.progress" && p.state === "running") {
      // `label`, which is what the schema calls it. The first version read
      // `p.title` — a field that does not exist — got `undefined`, and dropped
      // every task silently. Second time in this one function that a wrong
      // field name produced an empty list rather than an error.
      const label = String(p.label ?? "");
      if (label) out.push({ seq: event.seq, label: label.slice(0, 70), ts });
    }
  }
  return out;
}

export function RewindDialog({ onClose }: { onClose: () => void }) {
  const missionId = useMissionStore((s) => s.missionId);
  const events = useEventStore((s) => s.events);
  const [seq, setSeq] = useState<number | null>(null);
  const [plan, setPlan] = useState<RewindPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const points = useMemo(
    () => pointsFrom(events).slice(-40).reverse(),
    [events],
  );

  useEffect(() => {
    if (seq === null || !missionId) return;
    let alive = true;
    setPlan(null);
    void api
      .rewindPlan(missionId, seq)
      .then((p) => alive && setPlan(p))
      .catch(
        (err) =>
          alive &&
          setError((err as { message?: string })?.message ?? String(err)),
      );
    return () => {
      alive = false;
    };
  }, [seq, missionId]);

  async function apply() {
    if (seq === null || !missionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.rewind(missionId, seq);
      setDone(res.restored.length);
    } catch (err) {
      setError((err as { message?: string })?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="absolute inset-x-3 bottom-full z-30 mb-2 rounded-card border border-line bg-solid-2 p-3 shadow-lg"
      role="dialog"
      aria-label={strings.commands.rewindTitle}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-text">
          {strings.commands.rewindTitle}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[24px] rounded-card px-2 text-[11px] text-muted hover:bg-solid hover:text-text"
        >
          {strings.commands.rewindCancel}
        </button>
      </div>

      {done !== null ? (
        <div className="space-y-1">
          <p className="text-xs text-text">
            {strings.commands.rewindDone(done)}
          </p>
          {/* Said after the fact as well as before it: a change you can undo
              the same way is a different thing from one you cannot. */}
          <p className="text-[11px] text-faint">
            {strings.commands.rewindKept}
          </p>
        </div>
      ) : points.length === 0 ? (
        <p className="text-xs text-faint">{strings.commands.rewindNothing}</p>
      ) : (
        <>
          <p className="mb-1.5 text-[11px] text-faint">
            {strings.commands.rewindPick}
          </p>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto">
            {points.map((point) => (
              <li key={point.seq}>
                <button
                  type="button"
                  onClick={() => setSeq(point.seq)}
                  className={cn(
                    "flex w-full min-h-[24px] items-baseline gap-2 rounded-card px-2 py-1 text-left text-xs",
                    seq === point.seq
                      ? "bg-solid text-text"
                      : "text-muted hover:bg-solid hover:text-text",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{point.label}</span>
                  {point.ts ? (
                    <span className="shrink-0 text-[11px] text-faint tabular-nums">
                      {formatTime(new Date(point.ts))}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {seq !== null && plan ? (
            <div className="mt-2 space-y-1 border-t border-line pt-2">
              <p className="text-xs text-text">
                {plan.willChange > 0
                  ? strings.commands.rewindWillChange(plan.willChange)
                  : strings.commands.rewindNoChange}
              </p>
              <ul className="max-h-32 space-y-0.5 overflow-y-auto">
                {plan.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex items-baseline gap-2 text-[11px]"
                  >
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono",
                        file.action === "restore" ? "text-text" : "text-faint",
                      )}
                    >
                      {file.path}
                    </span>
                    {/* Named, never colour alone (§18.3) — and an action this
                        build has not heard of prints its own name rather than
                        being dropped (§8). */}
                    <span className="shrink-0 text-faint">
                      {strings.commands.action[file.action] ?? file.action}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-faint">
                {strings.commands.rewindLimit}
              </p>
              {plan.willChange > 0 ? (
                <Button
                  type="button"
                  onClick={() => void apply()}
                  disabled={busy}
                >
                  {busy
                    ? strings.commands.rewindBusy
                    : strings.commands.rewindApply}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {error ? <p className="pt-1 text-[11px] text-stop">{error}</p> : null}
    </div>
  );
}
