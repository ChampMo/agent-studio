/**
 * The raw event stream, in sequence.
 *
 * This is the observability claim made concrete (PROJECT_BRIEF.md §1): if the
 * scene ever shows something this list does not, one of them is lying. It also
 * proves the §8 rule visually — unknown event types get a fallback row instead
 * of disappearing.
 */
import { useEventStore } from "../../stores/eventStore";
import { describe } from "../../transport/decode";
import { useMissionStore } from "../../stores/missionStore";
import { strings } from "../../lib/constants/strings.en";
import { Badge } from "../../components/ui/primitives";

export function TimelinePanel() {
  const events = useEventStore((s) => s.events);
  const malformed = useEventStore((s) => s.malformed);
  // Names come from the mission's frozen roster, never from the agents table:
  // that is what keeps a replay showing who actually did the work (§5.1).
  //
  // The roster is subscribed to as well as the resolver. `nameOf` is a stable
  // function reference, so selecting only that leaves this component rendering
  // raw agent ids until something else happens to re-render it.
  const roster = useMissionStore((s) => s.roster);
  const nameOf = useMissionStore((s) => s.nameOf);
  void roster;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {strings.timeline.title}
        </h2>
        <p className="mt-1 text-xs text-slate-500">{strings.timeline.hint}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 font-mono text-xs">
        {events.length === 0 && malformed.length === 0 ? (
          <p className="px-2 py-4 text-slate-500">{strings.timeline.empty}</p>
        ) : null}

        {events.map(({ event, known, futureVersion }) => (
          <div
            key={event.id}
            className="flex gap-2 border-b border-slate-900 px-2 py-1.5"
          >
            <span className="w-8 shrink-0 text-right text-slate-600">{event.seq}</span>
            <span className="w-16 shrink-0 text-slate-500">
              {new Date(event.ts).toLocaleTimeString()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={known ? "text-sky-400" : "text-amber-400"}>
                  {event.draft.type}
                </span>
                {/* An event this build has never heard of still happened, so it
                    gets a row rather than being dropped (§8). */}
                {!known ? (
                  <Badge tone="warn">{strings.timeline.unknownType}</Badge>
                ) : null}
                {futureVersion ? (
                  <Badge tone="warn">{strings.timeline.futureVersion}</Badge>
                ) : null}
              </div>
              <div className="break-words text-slate-300">
                {describe(event, nameOf)}
              </div>
            </div>
          </div>
        ))}

        {malformed.map((entry, i) => (
          <div key={i} className="flex gap-2 border-b border-slate-900 px-2 py-1.5">
            <span className="w-8 shrink-0 text-right text-slate-600">—</span>
            <div className="min-w-0 flex-1">
              <Badge tone="bad">{strings.timeline.malformed}</Badge>
              <div className="break-words text-slate-400">{entry.reason}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
