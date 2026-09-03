/**
 * The record of a run, arranged as a conversation (§18.2).
 *
 * This is still the observability claim made concrete (PROJECT_BRIEF.md §1): if
 * the scene ever shows something this list does not, one of them is lying. What
 * changed is the shape, not the contents — `buildTranscript` is where the rule
 * that nothing may be dropped is written down and tested, including unknown
 * event types (§8) and frames that could not be read at all.
 *
 * Bubbles carry words. Everything else — tool calls, statuses, the run starting
 * and ending — is a quieter row, because "Source Scout calls grep" is not
 * something Source Scout *said*, and a chat that dresses actions as speech is a
 * chat that invents dialogue.
 *
 * The list is a `log` with `aria-live="off"` on purpose. A running mission
 * publishes several events a second, and an assertive log turns a screen reader
 * into an unusable stream of token deltas. What is announced instead is one
 * hidden region carrying only mission-level turns — started, ended, a question
 * waiting, a budget warning — the handful of things worth interrupting for.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEventStore } from "../../stores/eventStore";
import { useApprovalStore } from "../../stores/approvalStore";
import { describe } from "../../transport/decode";
import { useMissionStore } from "../../stores/missionStore";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/format";
import { Portrait } from "../../components/ui/Portrait";
import { buildTranscript, type Row, type Tone } from "./transcript";
import { AttachedImage } from "./AttachedImage";
import { MarkdownBody } from "./MarkdownBody";
import {
  PAGE,
  WINDOW,
  addressedToUser,
  groupRows,
  isGroup,
  windowed,
  type ActivityGroup,
} from "./tiers";
import { AskRowView } from "./AskRowView";

/** The turns worth interrupting someone for. Everything else is detail. */
const ANNOUNCED = new Set([
  "mission.started",
  "mission.ended",
  "agent.request",
  "agent.request.resolved",
  "budget.warning",
  "error",
]);

const TONE_TEXT: Record<Tone, string> = {
  idle: "text-faint",
  search: "text-search",
  write: "text-write",
  wait: "text-wait",
  stop: "text-stop",
  done: "text-done",
};

const TONE_DOT: Record<Tone, string> = {
  idle: "bg-idle",
  search: "bg-search",
  write: "bg-write",
  wait: "bg-wait",
  stop: "bg-stop",
  done: "bg-done",
};

export function TimelinePanel() {
  const events = useEventStore((s) => s.events);
  const malformed = useEventStore((s) => s.malformed);
  const streaming = useEventStore((s) => s.streaming);
  const replaying = useEventStore((s) => s.replaying);
  // Names and faces come from the mission's frozen roster, never from the
  // agents table: that is what keeps a replay showing who actually did the
  // work (§5.1).
  //
  // The roster is subscribed to as well as the resolvers. `nameOf` is a stable
  // function reference, so selecting only that leaves this component rendering
  // raw agent ids until something else happens to re-render it.
  const roster = useMissionStore((s) => s.roster);
  const nameOf = useMissionStore((s) => s.nameOf);
  const avatarOf = useMissionStore((s) => s.avatarOf);
  const draft = useMissionStore((s) => s.draft);
  const missionId = useMissionStore((s) => s.missionId);
  // `roster` is not read directly — `nameOf` and `avatarOf` close over it — but
  // it has to be *subscribed to* and it has to be in the memo lists below.
  // Subscribing alone is not enough: those resolvers are zustand actions whose
  // identity never changes, so a memo keyed only on them keeps the rows it
  // built before the roster arrived, and the transcript prints raw agent ids
  // for the whole run while the rail and the scene show real names. Seen live
  // — the same trap CLAUDE.md records for the selector, one level further in.

  const scroller = useRef<HTMLDivElement>(null);
  /** Whether the reader is at the bottom. A transcript that yanks itself down
   *  while someone is reading further up is worse than one that never moves. */
  const pinned = useRef(true);
  const pending = useApprovalStore((s) => s.pending);
  /** Everything the agents said to each other, hidden. Off by default: the
   *  whole record is the point of this panel, and a filter left on is a
   *  filter someone forgets is on. */
  const [mineOnly, setMineOnly] = useState(false);
  /** How many rows have arrived since the reader stopped following. Shown as a
   *  button rather than acted on: yanking the view down while someone is
   *  reading is the thing the pin exists to prevent, and silently doing
   *  nothing leaves them wondering whether the run has stalled. */
  const [behind, setBehind] = useState(0);
  const seenCount = useRef(0);
  const [limit, setLimit] = useState(WINDOW);

  const rows = useMemo(
    () => buildTranscript(events, streaming, nameOf, malformed),
    [events, streaming, nameOf, malformed, roster],
  );

  // A replay is a record being read, not something happening now, so nothing
  // in it is announced.
  // Folded here, not in `buildTranscript`: that function's contract is one row
  // per event, and it is what makes the transcript checkable against the log.
  // The fold is a reading of those rows, and it keeps every one of them.
  // How many the filter *would* hide, worked out whether or not it is on. The
  // first version measured `rows.length - shown.length`, which is zero until
  // the filter is already on — so the control that turns it on never appeared.
  const hidable = useMemo(
    () => rows.filter((row) => !addressedToUser(row)).length,
    [rows],
  );
  const shown = useMemo(
    () => (mineOnly ? rows.filter(addressedToUser) : rows),
    [rows, mineOnly],
  );
  const grouped = useMemo(() => groupRows(shown), [shown]);
  // Only the newest page reaches the DOM. A reader opens a run at the bottom,
  // so that is the only part which has to exist before the first paint —
  // everything above is one press away and the button says how much.
  const view = useMemo(() => windowed(grouped, limit), [grouped, limit]);

  const announcement = useMemo(() => {
    if (replaying) return "";
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const entry = events[i]!;
      if (ANNOUNCED.has(entry.event.draft.type)) return describe(entry.event, nameOf);
    }
    return "";
  }, [events, replaying, nameOf, roster]);

  // Opening a run puts you at the newest message, the way opening a chat does.
  // `useLayoutEffect` so it happens before the paint: scrolling after one is a
  // visible jump from the top.
  //
  // Keyed on the mission, not on mount. This component does not unmount when
  // you switch runs, so a reader who had scrolled up in the last one would
  // otherwise open the next one already unpinned — reading someone else's
  // history from the middle.
  useLayoutEffect(() => {
    pinned.current = true;
    setBehind(0);
    // Back to one page when the run changes: a reader who had opened the whole
    // of a long conversation should not pay for it again on the next one.
    setLimit(WINDOW);
    seenCount.current = rows.length;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    // `rows` deliberately absent: this runs when the *mission* changes, and
    // re-running it on every new row would be the yank it exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId]);

  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) {
      element.scrollTop = element.scrollHeight;
      seenCount.current = rows.length;
      setBehind(0);
      return;
    }
    setBehind(Math.max(0, rows.length - seenCount.current));
  }, [rows]);

  //: The question this run is stopped on, if it is stopped on one. The store
  //: is refreshed over REST on mount and updated off the stream, so it covers
  //: a question asked before this window existed.
  const waiting = useMemo(() => {
    const mine = pending.find((p) => p.missionId === missionId);
    if (!mine) return null;
    return { requestId: mine.requestId, name: mine.agentId ? nameOf(mine.agentId) : "" };
  }, [pending, missionId, nameOf, roster]);

  const jumpToAsk = () => {
    if (!waiting) return;
    const card = scroller.current?.querySelector(`[data-ask="${waiting.requestId}"]`);
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const follow = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    seenCount.current = rows.length;
    setBehind(0);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Off-screen and polite: the only thing that speaks on its own. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {/* A question the run has stopped on, held above the scroll until it is
          answered.

          It was already a card in the stream, and in the stream is where it
          drowns: twenty tool lines land after it and it is gone, with nothing
          left saying the run is not merely slow. The card stays where it
          happened — that is the record — and this is the part that cannot be
          allowed to scroll away.

          Read from `approvalStore`, not from the log: whether anyone is still
          waiting is a fact the backend owns, and a question from a run that
          was cancelled while parked is on the log for ever (§2.1). */}
      {waiting ? (
        <button
          type="button"
          onClick={jumpToAsk}
          className={cn(
            "flex w-full min-h-[24px] items-center gap-2 border-b border-wait/40",
            "bg-wait/10 px-4 py-2 text-left text-xs text-wait hover:bg-wait/15",
          )}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-wait" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {strings.timeline.waitingOn(waiting.name)}
          </span>
          <span className="shrink-0 text-[11px] opacity-80">
            {strings.timeline.goToQuestion}
          </span>
        </button>
      ) : null}

      {/* Offered only when it would actually hide something, and it says how
          much — a filter whose effect you cannot see is one you cannot trust
          to have kept the rest. */}
      {hidable > 0 ? (
        <div className="flex items-center gap-2 border-b border-line px-4 py-1.5">
          <button
            type="button"
            onClick={() => setMineOnly((was) => !was)}
            aria-pressed={mineOnly}
            className={cn(
              "min-h-[24px] rounded-card border px-2 py-1 text-[11px] transition-colors",
              mineOnly
                ? "border-accent/50 bg-accent/10 text-text"
                : "border-line text-muted hover:bg-solid hover:text-text",
            )}
          >
            {strings.timeline.mineOnly}
          </button>
          <span className="text-[11px] text-faint">
            {mineOnly
              ? strings.timeline.hiddenCount(hidable)
              : strings.timeline.mineOnlyHint}
          </span>
        </div>
      ) : null}

      {/* Wrapped so the button can sit over the scroller's bottom edge without
          being inside the scroll itself. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="log"
        aria-live="off"
        aria-label={strings.timeline.title}
        onScroll={(event) => {
          const el = event.currentTarget;
          // 40px of slack: "near the bottom" is what a reader means by being at
          // it, and an exact comparison fails on fractional scroll heights.
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          pinned.current = atBottom;
          if (atBottom) {
            seenCount.current = rows.length;
            setBehind(0);
          }
        }}
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4"
      >
        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-faint">
            {draft ? strings.timeline.emptyDraft : strings.timeline.empty}
          </p>
        ) : null}

        {/* Counted, never merely cut off. The same rule the activity fold and
            the "only what involves me" filter follow: a reader has to be able
            to see that something is above them, or the transcript stops being
            something a run can be checked against. */}
        {view.hidden > 0 ? (
          <button
            type="button"
            onClick={() => setLimit((was) => was + PAGE)}
            className={cn(
              "mx-auto flex min-h-[24px] items-center rounded-card border border-line",
              "px-3 py-1 text-[11px] text-muted hover:bg-solid hover:text-text",
            )}
          >
            {strings.timeline.showEarlier(view.hidden)}
          </button>
        ) : null}

        {view.items.map((item) =>
          isGroup(item) ? (
            <ActivityFold key={item.id} group={item} avatarOf={avatarOf} />
          ) : (
            <RowView key={item.id} row={item} avatarOf={avatarOf} />
          ),
        )}
      </div>

      {/* Not a scroll that yanks itself down. A reader who has gone up is
          reading something, and moving the view out from under them is the
          thing the pin exists to prevent — but saying nothing leaves them
          wondering whether the run has stalled. So: what arrived, and a way
          back, taken only when asked. */}
      {behind > 0 ? (
        <button
          type="button"
          onClick={follow}
          className={cn(
            "absolute inset-x-0 bottom-2 mx-auto flex w-fit min-h-[24px] items-center gap-1.5",
            "rounded-full border border-line bg-solid-2 px-3 py-1.5 text-[11px]",
            "text-muted shadow-lg hover:bg-solid hover:text-text",
          )}
        >
          {strings.timeline.newBelow(behind)}
          <span aria-hidden>↓</span>
        </button>
      ) : null}
      </div>
    </div>
  );
}

/**
 * A run of background activity, folded to one line.
 *
 * Counted, never cut. The number is the promise that expanding gives back
 * exactly what it says — a timeline that hid rows quietly would stop being
 * something a run can be checked against, which is the reason the transcript
 * is one row per event to begin with (§1).
 *
 * Summarised by how many, not by which tools: "6 steps" is honest and needs no
 * vocabulary. Naming the tools in the summary would mean deciding which of six
 * calls is the interesting one, which is a judgement the fold has no business
 * making — they are all one click away.
 */
function ActivityFold({
  group,
  avatarOf,
}: {
  group: ActivityGroup;
  avatarOf: (agentId: string) => Record<string, string> | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group/fold">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className={cn(
          "flex w-full min-h-[24px] items-center gap-2 rounded-card px-1 py-1",
          "text-left text-[11px] text-faint hover:bg-solid hover:text-muted",
        )}
      >
        <span
          className={cn(
            "inline-block w-2 shrink-0 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        >
          ›
        </span>
        {group.name ? <span className="shrink-0 text-muted">{group.name}</span> : null}
        {/* What it did, not how many rows it took. "16 steps" can only be
            opened; "wrote 4 files · package.json, tsconfig.json +2" can be
            judged — and a fold nobody dares leave shut has bought nothing. */}
        <span className="min-w-0 truncate">
          {group.wrote > 0
            ? strings.timeline.foldedWrote(group.wrote, group.files)
            : strings.timeline.folded(group.count)}
        </span>
        {/* A failure inside is visible from the outside. Otherwise the safe
            move is to open every group, and the fold is undone. */}
        {group.failed ? (
          <span className="shrink-0 text-stop">{strings.timeline.foldedFailed}</span>
        ) : null}
        {group.ts ? (
          <time className="ml-auto shrink-0 opacity-0 transition-opacity group-hover/fold:opacity-100">
            {formatTime(new Date(group.ts))}
            {group.until && group.until !== group.ts
              ? `–${formatTime(new Date(group.until))}`
              : ""}
          </time>
        ) : null}
      </button>
      {open ? (
        <div className="ml-3 border-l border-line pl-3">
          {group.rows.map((row) => (
            <RowView key={row.id} row={row} avatarOf={avatarOf} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A note whose full text is a paragraph, shown as a line until asked.
 *
 * A round's closing report and a paragraph-long answer to a question were each
 * printed in full, centred, between two rules — the two longest things on the
 * timeline, in the shape reserved for the shortest. Nothing is dropped: the
 * line says what happened and the body is one click away.
 */
function NoteWithDetail({ row }: { row: Extract<Row, { kind: "note" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5">
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-line" />
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          className={cn(
            "flex min-h-[24px] max-w-[80%] items-center gap-1.5 rounded-card px-2 py-0.5",
            "text-center text-[11px] hover:bg-solid",
            TONE_TEXT[row.tone] ?? "text-faint",
          )}
        >
          <span className="truncate">{row.text}</span>
          <span
            className={cn("shrink-0 opacity-60 transition-transform", open && "rotate-90")}
            aria-hidden
          >
            ›
          </span>
        </button>
        <span className="h-px flex-1 bg-line" />
      </div>
      {open ? (
        <div className="mx-auto mt-1 max-w-[80%] rounded-[9px] bg-solid-2 px-3 py-2">
          <MarkdownBody source={row.detail ?? ""} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tool line whose result is a page, not a sentence.
 *
 * A failed `bash` reports what the command printed, and one that printed a
 * stylesheet turned a single row into a wall of red across the messages either
 * side of it. The line says what happened; the output is one click away.
 */
function DidWithDetail({ row }: { row: Extract<Row, { kind: "did" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-9 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className={cn(
          "flex w-full min-h-[24px] items-start gap-2 rounded-card py-0.5 text-left",
          "hover:bg-solid",
          TONE_TEXT[row.tone],
        )}
      >
        <span
          aria-hidden="true"
          className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", TONE_DOT[row.tone])}
        />
        <span className="min-w-0 flex-1 truncate">{row.text}</span>
        <span
          className={cn("shrink-0 opacity-60 transition-transform", open && "rotate-90")}
          aria-hidden
        >
          ›
        </span>
      </button>
      {open ? (
        <pre className="ml-3.5 mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[9px] bg-solid-2 p-2.5 text-[11px] text-muted">
          {row.detail}
        </pre>
      ) : null}
    </div>
  );
}

function RowView({
  row,
  avatarOf,
}: {
  row: Row;
  avatarOf: (agentId: string) => Record<string, string> | null;
}) {
  if (row.kind === "ask") {
    return (
      <AskRowView row={row} avatar={row.agentId ? avatarOf(row.agentId) : null} />
    );
  }

  if (row.kind === "broken") {
    return (
      <p className="rounded-[9px] border border-stop/40 bg-stop/10 px-3 py-2 text-xs text-stop">
        {strings.timeline.malformed}: {row.reason}
      </p>
    );
  }

  if (row.kind === "note") {
    // An attachment gets the picture under its line. Everything else is a
    // centred divider, and a thumbnail does not fit between two rules.
    if (row.attachmentId) {
      return (
        <div className="flex flex-col items-center gap-1 py-1">
          <span className="text-[11px] text-faint">{row.text}</span>
          <AttachedImage id={row.attachmentId} alt={row.text} />
        </div>
      );
    }

    if (row.detail) return <NoteWithDetail row={row} />;

    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="h-px flex-1 bg-line" />
        <span
          className={cn(
            "flex max-w-[80%] items-center gap-1.5 text-center text-[11px]",
            TONE_TEXT[row.tone],
          )}
        >
          {row.unknownType ? (
            // §8 made visible: a type this build does not know still shows,
            // and says so rather than pretending to be understood.
            <span className="rounded bg-wait/15 px-1.5 py-0.5 font-mono text-wait">
              {row.unknownType}
            </span>
          ) : null}
          <span>{row.text}</span>
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }

  if (row.kind === "busy") {
    return (
      <div className="flex items-center gap-2.5">
        <div className="w-9 shrink-0">
          <Portrait
            avatar={avatarOf(row.agentId)}
            name={row.name || "?"}
          />
        </div>
        <span
          // Announced, because for a blind reader this is the only sign that
          // the app is doing anything at all between one message and the next.
          role="status"
          className="flex items-center gap-2 rounded-[14px] rounded-bl-[4px] bg-solid-2 px-3.5 py-2.5 text-xs text-muted"
        >
          {row.spinning ? <Dots /> : null}
          <span>{strings.timeline.busy(row.name, row.status)}</span>
        </span>
      </div>
    );
  }

  if (row.kind === "did") {
    if (row.detail) return <DidWithDetail row={row} />;
    return (
      <div className="flex items-start gap-2 pl-9 text-[11px] text-faint">
        {row.pending ? (
          <Spinner className={TONE_TEXT[row.tone]} />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
              TONE_DOT[row.tone],
            )}
          />
        )}
        <span className="min-w-0 flex-1 break-words">
          {row.text}
          {row.pending ? <span className="opacity-70">…</span> : null}
        </span>
        {row.ts ? (
          <time className="shrink-0 tabular-nums opacity-60">
            {formatTime(new Date(row.ts))}
          </time>
        ) : null}
      </div>
    );
  }

  const mine = row.side === "right";

  return (
    <div
      className={cn(
        "group/row relative flex gap-2.5",
        mine ? "flex-row-reverse" : "flex-row",
      )}
    >
      {/* No column reserved on your own side. The face belongs to whoever
          spoke, and for your messages that is you — an empty 36px placeholder
          plus its gap held the bubble 46px off the edge for nothing. */}
      {!mine ? (
      <div className="w-9 shrink-0">
        {row.showHeader ? (
          <Portrait
            avatar={row.agentId ? avatarOf(row.agentId) : null}
            name={row.name || "?"}
          />
        ) : null}
      </div>
      ) : null}

      {/* One width for every bubble, and one left edge for every row. Three
          widths and three indents in one screen made the transcript read as
          three different lists that happened to be stacked. */}
      <div className={cn("flex min-w-0 max-w-[42rem] flex-1 flex-col", mine && "items-end")}>
        {!mine && row.showHeader && row.name ? (
          <span className="mb-1 flex items-baseline gap-1.5 px-1 text-xs">
            <span className="font-medium text-text">{row.name}</span>
            {/* Who it was for. Every line used to start with a speaker and
                never say the recipient, so a message to the team, a handover
                to one teammate and a question aimed at the reader all looked
                the same — and telling them apart is most of what reading a
                team's transcript is. */}
            {row.to ? (
              <span className="text-faint">
                {strings.timeline.addressedTo(row.to)}
              </span>
            ) : null}
          </span>
        ) : null}

        <div
          className={cn(
            "min-w-0 break-words rounded-panel px-3.5 py-2.5 text-sm leading-relaxed",
            mine
              ? "rounded-br-[4px] bg-accent/15 text-text"
              : "rounded-bl-[4px] bg-solid-2 text-text",
            // A tail on the last bubble of a run only, so a group of turns
            // reads as one block of speech rather than several.
            row.streaming && "opacity-90",
          )}
        >
          {/* Markdown once the message is settled; raw text while it streams.
              A half-arrived `**` or an unclosed fence would otherwise make the
              bubble reflow on every token — and a code block that opens and
              closes itself as the model types is harder to read than the
              characters were. */}
          {row.streaming ? (
            <span className="whitespace-pre-wrap">{row.text}</span>
          ) : (
            <MarkdownBody source={row.text} />
          )}
          {row.streaming ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent align-text-bottom" />
          ) : null}
        </div>

        {/* The clock appears when the mouse is on the message. A permanent
            column of 265 timestamps answers a question nobody asked: what a
            reader wants is how long ago, and which part of the run — and the
            usage figure beside it is real money, so that stays. */}
        <span className="mt-1 flex items-center gap-2 px-1 text-[10px] text-faint">
          {/* Real money and real counts, as numbers (§1.1) — and a detail you
              go looking for, like the clock. Per message it is a figure nobody
              reads on the way past; the panel carries the run's total, which is
              the one anybody acts on. */}
          {row.usage?.outputTokens ? (
            <span className="tabular-nums opacity-0 transition-opacity group-hover/row:opacity-100">
              {strings.timeline.usage(
                row.usage.inputTokens ?? 0,
                row.usage.outputTokens,
              )}
            </span>
          ) : null}
        </span>
      </div>

      {/* At the row's far edge, which is where the folds and the quiet lines
          keep theirs. Under the bubble it sat wherever that bubble happened to
          end, so a column of times ran in a ragged line down the middle of the
          transcript instead of down its side. */}
      {/* Taken out of the flow. It is transparent until the mouse is on the
          row, so as a flex item it was reserving width for something invisible
          — and that width is what pushed your own bubble away from the edge
          it should sit against. */}
      {row.ts ? (
        <time
          className={cn(
            "absolute top-1 text-[10px] text-faint tabular-nums",
            "opacity-0 transition-opacity group-hover/row:opacity-100",
            // One column down the right-hand side, for every row. The outer
            // flex is reversed for your own messages, so first in DOM order is
            // rightmost there —  puts the clock in the same place
            // on screen either way, which is the point of a column.
            // One column down the right-hand side, whoever spoke. The outer
            // flex is reversed for your own messages, so first in DOM order is
            // rightmost there — `order-first` lands the clock in the same
            // place on screen either way, which is the whole point of it being
            // a column rather than a label under each bubble.
            // Outside the bubble on the side away from it, so the clock never
            // sits over the words.
            mine ? "left-0" : "right-0",
          )}
        >
          {formatTime(new Date(row.ts))}
        </time>
      ) : null}
    </div>
  );
}

/**
 * A ring with a gap, turning.
 *
 * `aria-hidden`, always: every place this is used has words beside it saying
 * what is happening, and a spinner that announces itself would say "loading"
 * over the top of a sentence that already said which tool is running.
 *
 * `prefers-reduced-motion` stops the rotation in `index.css` along with every
 * other animation, which leaves a static ring — still visibly different from
 * the solid dot of a finished call, which is what the state has to convey.
 */
function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn("mt-0.5 h-3 w-3 shrink-0 animate-spin", className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="28"
        strokeDashoffset="10"
      />
    </svg>
  );
}

/** The three dots a chat app shows while the other side is typing. */
function Dots() {
  return (
    <span aria-hidden="true" className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
          // Staggered, so it reads as a wave rather than three things blinking
          // in unison.
          style={{ animationDelay: `${i * 160}ms`, animationDuration: "1.1s" }}
        />
      ))}
    </span>
  );
}
