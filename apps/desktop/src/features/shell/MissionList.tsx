/**
 * Every past run, down the left (§18.2).
 *
 * There is no separate History screen any more. A chat is a mission with one
 * seat (§15 row 4), so chats and team runs were always the same rows behind two
 * different tabs; this is that list, once.
 *
 * Each row says three things and no more: what state the run is in, what it was
 * asked to do, and — for a chat — that it was a chat. No member count, no
 * duration, no cost. Those belong to the run you have open, on the right, where
 * there is room to say them properly.
 *
 * **A run waiting on an answer says so here.** The question itself lives in the
 * transcript of the run that asked it, which is the right place to decide it —
 * and no place at all if that run is not the one on screen. This list is where
 * every run already is, so it is where a paused one is marked: the same
 * triangle, the same words, from the same table the rest of the app reads.
 */
import { useEffect, useMemo, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useApprovalStore } from "../../stores/approvalStore";
import { useHistoryStore } from "../../stores/historyStore";
import { useMissionStore } from "../../stores/missionStore";
import { useEndReason } from "../../stores/runState";
import { StatusMark } from "../../components/ui/StatusMark";
import { isUnread, useSeenStore } from "../../stores/seenStore";

import { groupByDay, matchesQuery } from "./missionGroups";

/** What to call a run in the list. A run recorded before migration 0010 has no
 *  title of its own; its goal is what it was called at the time, and renaming
 *  it retroactively would be rewriting the record (§5.1). */
function nameOfRun(mission: { title: string | null; goal: string }): string {
  return mission.title || mission.goal || "";
}

/** A hollow ring: nothing has happened, so there is nothing filled in. */
const DRAFT_LOOK = {
  shape: "ring",
  tone: "idle",
  label: strings.mission.notStarted,
} as const;

export function MissionList({
  query,
  onOpened,
}: {
  query: string;
  /** Opening a run from Settings has to put the run in front of you, or the
   *  click looks like it did nothing. */
  onOpened: () => void;
}) {
  const missions = useHistoryStore((s) => s.missions);
  const loading = useHistoryStore((s) => s.loading);
  const unreadable = useHistoryStore((s) => s.unreadable);
  const load = useHistoryStore((s) => s.load);
  const openMission = useHistoryStore((s) => s.openMission);
  const remove = useHistoryStore((s) => s.remove);
  //: A run that has been named but not said anything to. It has no row in the
  //: database — the first message creates that — so the list has to carry it
  //: itself, or pressing "Create run" looks like it did nothing.
  const draft = useMissionStore((s) => s.draft);
  //: Which run is on screen. Read from the mission store rather than from
  //: `historyStore.openId`, because that one is only set by *clicking* a row —
  //: a run started from the composer would leave the list marking nothing, or
  //: still marking the run before it.
  const openId = useMissionStore((s) => s.missionId);
  //: Which runs are parked on a question. `approvalStore` is the one place
  //: that knows — over REST on mount for questions older than this window, off
  //: the stream for ones asked while it is open. The row's own
  //: `pendingRequest` is a snapshot from whenever the list was last fetched,
  //: so reading it here would be a second answer to the same question that
  //: goes stale the moment one is answered (§2.1).
  const pendingRequests = useApprovalStore((s) => s.pending);
  const endReason = useEndReason();
  const [confirming, setConfirming] = useState<string | null>(null);
  const seen = useSeenStore((st) => st.seen);
  const markSeen = useSeenStore((st) => st.markSeen);

  useEffect(() => {
    void load();
  }, [load]);

  // The first message creates the mission, and until this the list went on
  // showing the state it was fetched in: the draft still sitting under "Not
  // started", the new run absent, and no way to notice short of reloading the
  // window. Keyed on the id, so it fires once per run rather than on activity.
  //
  // And again when it stops, for the other half of the same problem: a row
  // fetched while a run was working goes on saying "Working" after it has
  // finished in front of you. `useEndReason` reads the log first, so this
  // fires on the `mission.ended` itself rather than on a guess about timing.
  useEffect(() => {
    if (openId) void load();
  }, [openId, endReason, load]);

  // A run that finishes while you are watching it is not unread.
  //
  // `markSeen` on click records the ending the row had *at that moment*, which
  // for a run still going is none — so the mark never happened, and the run
  // turned orange the instant it finished, in front of the person who had been
  // watching it finish. This closes that: whenever the open run has an ending,
  // it is read.
  const items = missions;
  useEffect(() => {
    const open = items.find((m) => m.id === openId);
    if (open?.endedAt) markSeen(open.id, open.endedAt);
  }, [openId, items, markSeen]);

  const awaiting = useMemo(
    () => new Set(pendingRequests.map((r) => r.missionId)),
    [pendingRequests],
  );

  const groups = useMemo(
    () =>
      groupByDay(
        missions.filter((m) => matchesQuery(nameOfRun(m), query)),
        { today: strings.sidebar.today, yesterday: strings.sidebar.yesterday },
      ),
    [missions, query],
  );

  // Shown above the days, and outside the search: it is not history yet, and
  // filtering away the thing you just made would be worse than useless.
  const pending = draft ? (
    <section aria-label={strings.sidebar.notStarted}>
      <h2 className="px-2 pb-1 text-[11px] font-medium text-faint">
        {strings.sidebar.notStarted}
      </h2>
      <div
        aria-current="true"
        className="flex min-h-[24px] items-start gap-2 rounded-md border border-line bg-solid-2 px-2 py-1.5 text-left text-text"
      >
        <span className="mt-[5px]">
          <StatusMark look={DRAFT_LOOK} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{draft.title}</span>
          <span className="block truncate text-[11px] text-faint">
            {strings.mission.notStarted}
          </span>
        </span>
      </div>
    </section>
  ) : null;

  // A row the database could not hand back. It belongs at the foot of the
  // list and in the empty state alike — a database whose every row is damaged
  // would otherwise read "Nothing yet. Start a run to see it here.", which is
  // the app being untrue about what it holds (§1).
  const damaged =
    unreadable > 0 ? (
      <p className="px-2 py-2 text-[11px] text-faint">
        <span className="text-stop">{strings.sidebar.unreadable(unreadable)}</span>{" "}
        {strings.sidebar.unreadableHint(unreadable)}
      </p>
    ) : null;

  if (loading && missions.length === 0)
    return (
      <div className="space-y-3">
        {pending}
        <p className="px-2 py-3 text-xs text-faint">
          {strings.history.loading}
        </p>
      </div>
    );

  if (groups.length === 0)
    return (
      <div className="space-y-3">
        {pending}
        <p className="px-2 py-3 text-xs text-faint">
          {query.trim() ? strings.sidebar.noMatches : strings.sidebar.empty}
        </p>
        {damaged}
      </div>
    );

  return (
    <div className="space-y-3">
      {pending}
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="px-2 pb-1 text-[11px] font-medium text-faint">
            {group.label}
          </h2>
          <ul className="space-y-0.5">
            {group.items.map((mission) => {
              const selected = openId === mission.id;
              // Two things a dot can mean, and never at once. A run stopped
              // on a question is not "finished and unread" — it is *asking*,
              // which is the one thing in this list that needs an answer
              // rather than a read, so it wins.
              const asking = awaiting.has(mission.id);
              // Still going. `running` is the backend's own answer — *this
              // process is driving it* — rather than the row's `endReason`,
              // which is a snapshot from whenever the list was last fetched.
              // For the run on screen the log wins, the same order
              // `runState.ts` established.
              const working =
                !asking &&
                (mission.id === openId ? endReason === null : mission.running);
              const unread = !asking && !working && isUnread(seen, mission);
              return (
                <li key={mission.id} className="group/row relative">
                  <button
                    type="button"
                    onClick={() => {
                      // Opening it is reading it. Recorded against the ending
                      // it had at that moment, so a run continued later and
                      // finished again comes back unread.
                      markSeen(mission.id, mission.endedAt);
                      void openMission(mission.id);
                      onOpened();
                    }}
                    // The row is the thing you are looking at, not a link to a
                    // page, so `true` rather than `page`.
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "flex w-full min-h-[24px] items-start gap-2 rounded-md px-2 py-1.5 pr-7 text-left",
                      // The selected row is a block, not a tinted row with a
                      // dot: it is where you are, and it should read that way
                      // at a glance down a list of seventeen.
                      // The sidebar column is `--color-solid`, so a row that
                      // hovered to `--color-solid` painted the colour it was
                      // already on and nothing happened. Everything in this
                      // column raises to `--color-solid-2`.
                      selected
                        ? "bg-solid-2 text-text shadow-[inset_2px_0_0_0_var(--color-accent)]"
                        : "text-muted hover:bg-solid-2 hover:text-text",
                    )}
                  >
                    {/* The title, and nothing else on the line.

                        The state used to be printed under every row —
                        *Finished*, *Out of budget*, *Stopped badly*, seventeen
                        times down the side of a window whose middle column
                        says it about the run you actually have open. True, and
                        repeated, and answering a question nobody asked. The
                        time went the same way: the day heading above already
                        says when, and the order says the rest.

                        What a list of past runs is for is the one thing it
                        could not say — which of these finished while you were
                        looking at something else. That is the dot, and it
                        means only that. */}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {nameOfRun(mission) || strings.history.noGoal}
                    </span>
                    {/* What it did *not* get through — and only that.
                        `2/2` is the ordinary outcome, so printing it down the
                        whole list is a column of noise that makes the one row
                        saying `1/4` harder to see rather than easier. A run
                        recorded before the counts were kept shows nothing at
                        all, because "0 of 0" reads as a run that finished
                        nothing, which is a different claim from "nobody
                        counted" (§5.1). */}
                    {mission.tasksTotal &&
                    (mission.tasksDone ?? 0) < mission.tasksTotal ? (
                      <span className="shrink-0 text-[11px] tabular-nums text-faint">
                        {strings.sidebar.tasks(
                          mission.tasksDone ?? 0,
                          mission.tasksTotal,
                        )}
                      </span>
                    ) : null}
                    {asking || working || unread ? (
                      <span
                        className={cn(
                          "mt-[7px] size-1.5 shrink-0 rounded-full",
                          // Three states, and each has a *shape* as well as a
                          // colour — a dot that only differed by hue would be
                          // three things nobody can tell apart (§18.3).
                          //
                          //   working  a pulsing accent dot: something is
                          //            happening and nothing is wanted of you
                          //   asking   a hollow attn ring: stopped, on a
                          //            question, and the ring is the hole the
                          //            answer goes in
                          //   unread   a solid attn dot: it finished and you
                          //            have not looked
                          //
                          // `motion-safe` because a blink is movement, and
                          // somebody who asked for less of it still needs to
                          // be able to see that the run is going.
                          working && "bg-accent motion-safe:animate-pulse",
                          asking && "border-[1.5px] border-attn",
                          unread && "bg-attn",
                        )}
                        // Not colour alone: the dot has a name, so it is a
                        // thing rather than a decoration to anyone reading
                        // this list with a screen reader (§18.3).
                        role="img"
                        aria-label={
                          asking
                            ? strings.sidebar.asking
                            : working
                              ? strings.sidebar.working
                              : strings.sidebar.unread
                        }
                      />
                    ) : null}
                  </button>

                  <button
                    type="button"
                    onClick={() => setConfirming(mission.id)}
                    aria-label={strings.sidebar.deleteRun(
                      nameOfRun(mission) || strings.history.noGoal,
                    )}
                    className={cn(
                      "absolute right-1 top-1.5 rounded px-1.5 py-0.5 text-xs text-faint",
                      "opacity-0 hover:bg-solid-2 hover:text-stop",
                      "group-hover/row:opacity-100 focus-visible:opacity-100",
                    )}
                  >
                    ×
                  </button>

                  {confirming === mission.id ? (
                    // Deleting a run is the one place the append-only log gives
                    // way (§2), so it says what goes and asks first.
                    <div className="mt-1 rounded-[9px] border border-stop/40 bg-stop/10 p-2 text-[11px] text-muted">
                      <p>{strings.history.deleteWarning}</p>
                      <div className="mt-1.5 flex gap-2">
                        <button
                          type="button"
                          disabled={mission.running}
                          onClick={() => {
                            void remove(mission.id);
                            setConfirming(null);
                          }}
                          className="rounded px-2 py-1 font-medium text-stop hover:bg-stop/15 disabled:opacity-40"
                        >
                          {strings.history.delete}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="rounded px-2 py-1 hover:bg-solid-2"
                        >
                          {strings.sidebar.cancel}
                        </button>
                      </div>
                      {mission.running ? (
                        <p className="mt-1 text-stop">
                          {strings.history.deleteRunning}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {damaged}
    </div>
  );
}
