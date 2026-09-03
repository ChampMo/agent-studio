/**
 * What this run has spent, and who is doing what (§18.2, §6.2).
 *
 * Every number here is read off the event log. None is estimated, projected or
 * smoothed — §1.1 rules out invented figures, and money is the one place where
 * a plausible-looking number is worse than no number.
 *
 * **Why there is no cost.** The shipped pricing table only carries rates that
 * were verifiable at release, so on any other model the row read "Not priced"
 * on every run, for ever. The alternative — asking the user to type their own
 * rate in — is a chore in exchange for a number their provider already shows
 * them. A row that is permanently blank is worse than no row, so there is none.
 *
 * **Why there is no "model calls 18 / 60" row.** The limit is real —
 * `max_llm_calls` is in the mission's budget — but the *count* lives in the
 * backend's `BudgetGuard` and cannot be derived from the log: `agent.message`
 * is deliberately not published for a round that only asked for tools ("an
 * empty bubble would suggest the agent said nothing when in fact it acted"), so
 * counting messages undercounts calls. A ratio built from the two would read
 * comfortably below a limit it was already close to — exactly the shape of lie
 * §1 forbids. So the count that *is* derivable is shown, called what it is:
 * replies.
 */
import type { SequencedEntry } from "../../stores/eventStore";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Billed differently, but they still consume context — and the backend's
   *  budget guard counts them, so anything drawn against `max_tokens` has to
   *  count them too. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface MemberVitals {
  agentId: string;
  /** Input + output, summed over every usage block this agent produced. */
  tokens: number;
  /** The latest `agent.status` they published, or null if they have not. */
  status: string | null;
}

export interface Vitals {
  tokens: number;
  /** From `missions.budget`. Null when the mission carries no ceiling. */
  maxTokens: number | null;
  replies: number;
  /** Time this round spent **working**, which is what the timeout measures.
   *  Wall clock minus every stretch the run stood waiting for a person. */
  elapsedMs: number;
  /** How much was taken off for that waiting, so the panel can say so rather
   *  than leaving a reader to wonder why the clock stalled. */
  parkedMs: number;
  timeoutMs: number | null;
  /** Across every round of this mission, not just the one on screen.
   *
   *  A conversation is the thing a person is actually working on, and its
   *  cost was nowhere: continuing a run resets the round's counters — rightly,
   *  because the limits are per round — so the panel forgot everything the
   *  moment you asked a second question.
   *
   *  **No ceiling goes beside these.** There is no mission-wide limit; each
   *  round gets a fresh budget. Drawing a total against a round's limit is
   *  exactly the mistake that put 45,856 / 200,000 over a run killed at
   *  200,811, and 1:27:47 / 1:00:00 over a run that was fine. A number with no
   *  limit is honest; a number beside the wrong limit is not. */
  missionTokens: number;
  missionReplies: number;
  missionElapsedMs: number;
  byAgent: Map<string, MemberVitals>;
}

export interface Budget {
  max_tokens?: number;
  max_llm_calls?: number;
  timeout_sec?: number;
  max_supersteps?: number;
}

function usageOf(payload: unknown): Usage | null {
  const usage = (payload as { usage?: Usage } | null)?.usage;
  return usage && typeof usage === "object" ? usage : null;
}

/**
 * What one call spent against the token ceiling.
 *
 * The same four fields `BudgetTracker.record_call` adds up, and that is the
 * whole point: this number is displayed as `used / max_tokens`, so counting
 * anything different makes the meter disagree with the limit beside it.
 *
 * Found on a run that stopped at "200,811/200,000" while the rail read 45,856 —
 * input and output only. Cache reads dominate a long run, so the bar sat at a
 * quarter full at the moment the budget guard stopped the mission (§1, §10).
 */
function billable(usage: Usage): number {
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

export function deriveVitals({
  events,
  budget,
  startedAt,
  endedAt,
  now = Date.now(),
}: {
  events: SequencedEntry[];
  budget: Budget | null;
  startedAt: string | null;
  endedAt: string | null;
  now?: number;
}): Vitals {
  let tokens = 0;
  let replies = 0;
  const byAgent = new Map<string, MemberVitals>();

  const track = (agentId: string): MemberVitals => {
    let row = byAgent.get(agentId);
    if (!row) {
      row = { agentId, tokens: 0, status: null };
      byAgent.set(agentId, row);
    }
    return row;
  };

  let ended = false;
  /** Who asked the question currently outstanding, so the answer can end their
   *  wait. */
  let asking: string | null = null;
  // Where the round on screen began and ended. A mission can be continued, so
  // "time used" measured from the mission's own `startedAt` reported 6:44:04
  // against a 15:00 limit on a round four seconds old — the clock counting the
  // hours the conversation had been sitting there waiting to be continued.
  let roundStart: string | null = startedAt;
  let roundEnd: string | null = null;
  // Time the run stood still waiting for a person, which the backend's clock
  // does not count and this one therefore must not either.
  //
  // `BudgetTracker.elapsed_sec` subtracts it deliberately: measured on two real
  // builds, 93% and 90% of their 1,300 seconds was time parked on an approval,
  // so counting it made turning the gate on a way to die of the clock. This
  // function counted plain wall clock and drew it against that same limit —
  // and a run parked for 58 minutes read **1:27:47 / 1:00:00**, over its
  // ceiling, still working, because the number and the limit beside it were
  // measuring two different things (§1, and the same rule that made the token
  // meter count the four fields the guard counts).
  //
  // Derived from the log, not fetched: the waits are `agent.request` ->
  // `agent.request.resolved`, and one derivation is the whole point (§2.1).
  let parkedMs = 0;
  let parkedFrom: number | null = null;
  //: Totals for the whole conversation, which nothing resets.
  let missionTokens = 0;
  let missionReplies = 0;
  //: Working time from rounds that have already ended. The round in progress
  //: is added at the end, once its own clock has been worked out.
  let endedRoundsMs = 0;
  // Re-entrant, mirroring the tracker: a tool approval inside a turn that is
  // itself inside a paused graph is one wait, not two. The outermost owns it.
  let waitDepth = 0;

  for (const { event } of events) {
    const type = event.draft.type;
    const p = event.draft.payload as unknown as Record<string, unknown>;
    const agentId = typeof p.agentId === "string" ? p.agentId : null;

    if (type === "agent.status" && agentId) {
      track(agentId).status = String(p.status ?? "");
    }
    if (type === "agent.request") {
      asking = agentId;
      if (waitDepth === 0) parkedFrom = Date.parse(event.ts);
      waitDepth += 1;
    }
    if (type === "agent.request.resolved") {
      waitDepth = Math.max(0, waitDepth - 1);
      if (waitDepth === 0 && parkedFrom !== null) {
        parkedMs += Math.max(0, Date.parse(event.ts) - parkedFrom);
        parkedFrom = null;
      }
      // The answer ends the wait, and the log says so. An asker publishes
      // `waiting` when it asks and publishes nothing when it stops — so
      // without this the rail reads "Waiting on you" for the rest of the run,
      // describing a question answered minutes ago, with no card beside it to
      // answer. Exactly the bug `scene/bindings` already fixed for the pose.
      //
      // Derived, not invented: no synthetic `agent.status` is written. A later
      // real status still wins, because events are read in order.
      if (asking) track(asking).status = null;
      asking = null;
    }
    // The first event after a round ended opens the next one — and that is
    // where the counters go back to zero, not at the ending itself.
    //
    // They used to reset inside the `mission.ended` branch, and `mission.ended`
    // is the *last* event of a finished run: every token counted was wiped one
    // event before anyone could read it. The rail showed **0 / 200,000** on a
    // run whose own ending line said it stopped at 201,882.
    //
    // A round's tokens still count against a round's limit — continuing a run
    // gives it a fresh budget, so carrying the total forward would show a
    // conversation on its fourth round as permanently over a ceiling it is
    // nowhere near. That reset just belongs at the start of the next round,
    // which is the same rule `eventStore` uses to clear `endReason`.
    if (roundEnd !== null && type !== "mission.ended") {
      // Banked *before* the two are reassigned, or the round that just ended
      // is measured from its own replacement and contributes nothing.
      const from = roundStart ? Date.parse(roundStart) : NaN;
      const to = roundEnd ? Date.parse(roundEnd) : NaN;
      if (!Number.isNaN(from) && !Number.isNaN(to)) {
        endedRoundsMs += Math.max(0, to - from - parkedMs);
      }
      roundStart = event.ts;
      roundEnd = null;
      ended = false;
      tokens = 0;
      replies = 0;
      parkedMs = 0;
      parkedFrom = null;
      waitDepth = 0;
      for (const row of byAgent.values()) row.tokens = 0;
    }

    if (type === "mission.ended") {
      ended = true;
      roundEnd = event.ts;
      // A run cancelled or reaped while parked publishes no `resolved`. The
      // ending is where that wait stopped, so close it here rather than
      // letting it run to `now` over a finished record.
      if (parkedFrom !== null) {
        parkedMs += Math.max(0, Date.parse(event.ts) - parkedFrom);
        parkedFrom = null;
      }
      waitDepth = 0;
    }
    if (type === "agent.message") {
      replies += 1;
      missionReplies += 1;
    }

    const usage = usageOf(p);
    if (!usage) continue;
    const spent = billable(usage);
    tokens += spent;
    missionTokens += spent;
    if (agentId) track(agentId).tokens += spent;
  }

  // The ending is the terminal reset, the same rule the scene and the
  // transcript follow: a cancelled run's last status was true when written and
  // is not true now.
  if (ended) for (const row of byAgent.values()) row.status = null;

  // Measured over the round, not the mission. `endedAt` is the row's, which
  // agrees with the log for a single-round run and is stale the moment one is
  // continued — the log is the record either way (§2.1).
  const began = roundStart ? Date.parse(roundStart) : NaN;
  const finished = roundEnd ? Date.parse(roundEnd) : endedAt ? Date.parse(endedAt) : now;
  // A question still on screen is still being waited on, right now.
  if (parkedFrom !== null && !Number.isNaN(finished)) {
    parkedMs += Math.max(0, finished - parkedFrom);
    parkedFrom = null;
  }
  const elapsedMs =
    Number.isNaN(began) || Number.isNaN(finished)
      ? 0
      : Math.max(0, finished - began - parkedMs);

  return {
    tokens,
    maxTokens: budget?.max_tokens ?? null,
    replies,
    elapsedMs,
    parkedMs,
    timeoutMs: budget?.timeout_sec ? budget.timeout_sec * 1000 : null,
    missionTokens,
    missionReplies,
    missionElapsedMs: endedRoundsMs + elapsedMs,
    byAgent,
  };
}

/** `1:52`, or `1:02:03` once a run passes an hour. Never rounded up: a run that
 *  has taken 59 seconds has not taken a minute. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** `4.2k`, the way the card shows it. Exact below 1,000, because "418" is as
 *  short as "0.4k" and tells you more. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

