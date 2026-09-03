import { describe, expect, it } from "vitest";
import { deriveVitals, formatDuration, formatTokens } from "./vitals";
import type { SequencedEntry } from "../../stores/eventStore";
import type { EventEnvelope } from "../../transport/events.generated";

let seq = 0;

function entry(type: string, payload: Record<string, unknown>): SequencedEntry {
  seq += 1;
  return {
    event: {
      id: `evt-${seq}`,
      seq,
      ts: "2026-09-01T12:00:00+00:00",
      missionId: "m1",
      v: 1,
      draft: { type, payload },
    } as unknown as EventEnvelope,
    known: true,
    futureVersion: false,
  };
}

function entryAt(
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): SequencedEntry {
  const e = entry(type, payload);
  return { ...e, event: { ...e.event, ts } as typeof e.event };
}

const usage = (input: number, output: number, cost?: number) => ({
  inputTokens: input,
  outputTokens: output,
  ...(cost === undefined ? {} : { costUsd: cost }),
});

describe("a run that has finished still says what it spent", () => {
  /* The reset lived inside the `mission.ended` branch, and `mission.ended` is
     the last event of a finished run — so every token counted was wiped one
     event before anyone could read it.

     The rail showed **0 / 200,000** and **Replies 0** under a run whose own
     ending line, three inches below, read *stopped at the tokens limit
     (201882/200000)*. Fifteen tests passed the whole time: every one of them
     ended its fixture before the ending. */

  it("keeps the tokens after mission.ended", () => {
    const v = deriveVitals({
      events: [
        entry("agent.message", { agentId: "a1", usage: usage(100, 50) }),
        entry("agent.usage", { agentId: "a1", usage: usage(900, 40) }),
        entry("mission.ended", { reason: "budget_exceeded" }),
      ],
      budget: { max_tokens: 200_000 },
      startedAt: "2026-09-01T12:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-01T12:01:00+00:00"),
    });
    expect(v.tokens).toBe(1090);
    expect(v.replies).toBe(1);
    expect(v.byAgent.get("a1")?.tokens).toBe(1090);
  });

  it("starts the next round at zero, not the ending of the last one", () => {
    // The behaviour the reset was there for, and it still holds: continuing a
    // run gives it a fresh budget, so a fourth round must not read as
    // permanently over a ceiling it is nowhere near.
    const v = deriveVitals({
      events: [
        entry("agent.message", { agentId: "a1", usage: usage(5_000, 1_000) }),
        entry("mission.ended", { reason: "completed" }),
        entry("user.message", { content: "one more thing" }),
        entry("agent.message", { agentId: "a1", usage: usage(10, 5) }),
      ],
      budget: { max_tokens: 200_000 },
      startedAt: "2026-09-01T12:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-01T12:01:00+00:00"),
    });
    expect(v.tokens).toBe(15);
    expect(v.replies).toBe(1);
    expect(v.byAgent.get("a1")?.tokens).toBe(15);
  });

  it("counts a tool round's cost, which carries no message", () => {
    // `agent.usage` exists because a round that only calls tools publishes no
    // `agent.message`, and its usage went missing with it.
    const v = deriveVitals({
      events: [
        entry("agent.usage", { agentId: "a1", usage: usage(21_000, 201) }),
        entry("mission.ended", { reason: "completed" }),
      ],
      budget: { max_tokens: 200_000 },
      startedAt: "2026-09-01T12:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-01T12:01:00+00:00"),
    });
    expect(v.tokens).toBe(21_201);
    // It is not a reply. The agent said nothing; it spent something.
    expect(v.replies).toBe(0);
  });
});

describe("what the run has spent", () => {
  it("adds up tokens from every usage block", () => {
    const v = deriveVitals({
      events: [
        entry("agent.message", { agentId: "a1", usage: usage(100, 50, 0.001) }),
        entry("agent.message", { agentId: "a2", usage: usage(200, 25, 0.002) }),
      ],
      budget: { max_tokens: 40000 },
      startedAt: null,
      endedAt: null,
    });

    expect(v.tokens).toBe(375);
    expect(v.maxTokens).toBe(40000);
  });


  it("counts cache tokens, because the budget guard does", () => {
    // The meter is drawn as `used / max_tokens`, so it has to count what the
    // limit counts. A real run stopped at "200,811/200,000" while the rail read
    // 45,856 — input and output only — so the bar was a quarter full at the
    // moment the mission was killed for being over (§1, §10).
    const v = deriveVitals({
      events: [
        entry("agent.message", {
          agentId: "a1",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 1400,
            cacheWriteTokens: 20,
          },
        }),
      ],
      budget: { max_tokens: 40000 },
      startedAt: null,
      endedAt: null,
    });

    expect(v.tokens).toBe(1570);
    expect(v.byAgent.get("a1")?.tokens).toBe(1570);
  });

  it("attributes tokens to the agent that spent them", () => {
    const v = deriveVitals({
      events: [
        entry("agent.message", { agentId: "a1", usage: usage(100, 50) }),
        entry("agent.message", { agentId: "a1", usage: usage(10, 5) }),
        entry("agent.message", { agentId: "a2", usage: usage(1, 1) }),
      ],
      budget: null,
      startedAt: null,
      endedAt: null,
    });

    expect(v.byAgent.get("a1")?.tokens).toBe(165);
    expect(v.byAgent.get("a2")?.tokens).toBe(2);
  });

  it("keeps each agent's latest status", () => {
    const v = deriveVitals({
      events: [
        entry("agent.status", { agentId: "a1", status: "thinking" }),
        entry("agent.status", { agentId: "a1", status: "working" }),
        entry("agent.status", { agentId: "a2", status: "waiting" }),
      ],
      budget: null,
      startedAt: null,
      endedAt: null,
    });

    expect(v.byAgent.get("a1")?.status).toBe("working");
    expect(v.byAgent.get("a2")?.status).toBe("waiting");
  });

  it("ends an agent's wait when its question is answered", () => {
    // An asker publishes `waiting` and publishes nothing when the answer
    // arrives, so without this the rail says "Waiting on you" for the rest of
    // the run — next to no card, because nothing is actually pending. The
    // scene already had this rule; the rail did not.
    const v = deriveVitals({
      events: [
        entry("agent.status", { agentId: "a1", status: "waiting" }),
        entry("agent.request", { agentId: "a1", requestId: "r1", question: "ok?" }),
        entry("agent.request.resolved", { requestId: "r1", answer: "approve" }),
      ],
      budget: null,
      startedAt: null,
      endedAt: null,
    });

    expect(v.byAgent.get("a1")?.status).toBeNull();
  });

  it("lets a real status published after the answer win", () => {
    const v = deriveVitals({
      events: [
        entry("agent.status", { agentId: "a1", status: "waiting" }),
        entry("agent.request", { agentId: "a1", requestId: "r1", question: "ok?" }),
        entry("agent.request.resolved", { requestId: "r1", answer: "approve" }),
        entry("agent.status", { agentId: "a1", status: "working" }),
      ],
      budget: null,
      startedAt: null,
      endedAt: null,
    });

    expect(v.byAgent.get("a1")?.status).toBe("working");
  });

  it("clears every status when the mission ends", () => {
    // The same terminal reset the scene and the transcript use: a cancelled
    // run's last status was true when written and is not true now.
    const v = deriveVitals({
      events: [
        entry("agent.status", { agentId: "a1", status: "thinking" }),
        entry("mission.ended", { reason: "cancelled" }),
      ],
      budget: null,
      startedAt: null,
      endedAt: null,
    });

    expect(v.byAgent.get("a1")?.status).toBeNull();
  });

  it("counts replies, which is not the same as model calls", () => {
    // A round that only asked for tools publishes no `agent.message`, so this
    // number is strictly below the backend's `llm_calls_used`. That is why it
    // is never drawn against `max_llm_calls`.
    const v = deriveVitals({
      events: [
        entry("agent.message", { agentId: "a1", usage: usage(1, 1) }),
        entry("agent.tool.start", { agentId: "a1", tool: "grep" }),
        entry("agent.tool.end", { agentId: "a1", ok: true }),
        entry("agent.message", { agentId: "a1", usage: usage(1, 1) }),
      ],
      budget: { max_llm_calls: 60 },
      startedAt: null,
      endedAt: null,
    });

    expect(v.replies).toBe(2);
  });

  it("measures a live run against now and a finished one against its ending", () => {
    const started = "2026-09-01T12:00:00+00:00";
    const live = deriveVitals({
      events: [],
      budget: { timeout_sec: 600 },
      startedAt: started,
      endedAt: null,
      now: Date.parse(started) + 112_000,
    });
    expect(live.elapsedMs).toBe(112_000);
    expect(live.timeoutMs).toBe(600_000);

    const done = deriveVitals({
      events: [],
      budget: null,
      startedAt: started,
      endedAt: "2026-09-01T12:01:15+00:00",
      now: Date.parse(started) + 999_000,
    });
    // The clock stopped when the run did, not when someone opened it.
    expect(done.elapsedMs).toBe(75_000);
  });

  it("counts a continued run's round, not the whole conversation", () => {
    // A mission can be continued, so measuring from the mission's own
    // `startedAt` reported "6:44:04 / 15:00" on a round four seconds old — the
    // clock counting the hours the conversation sat waiting to be continued.
    const t0 = "2026-09-02T10:00:00+00:00";
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(10, 10) }, t0),
        entryAt("mission.ended", { reason: "completed" }, "2026-09-02T10:05:00+00:00"),
        entryAt("user.message", { content: "one more thing" }, "2026-09-02T16:00:00+00:00"),
        entryAt("agent.message", { agentId: "a1", usage: usage(5, 5) }, "2026-09-02T16:00:10+00:00"),
      ],
      budget: { timeout_sec: 900 },
      startedAt: t0,
      endedAt: null,
      now: Date.parse("2026-09-02T16:00:30+00:00"),
    });

    // Thirty seconds into the second round, not six hours into the mission.
    expect(v.elapsedMs).toBe(30_000);
    // And the round's own tokens, against the round's own limit.
    expect(v.tokens).toBe(10);
    expect(v.replies).toBe(1);
  });

  it("stops a finished round's clock at its ending", () => {
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(1, 1) }, "2026-09-02T10:00:00+00:00"),
        entryAt("mission.ended", { reason: "completed" }, "2026-09-02T10:01:15+00:00"),
      ],
      budget: null,
      startedAt: "2026-09-02T10:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-02T18:00:00+00:00"),
    });
    expect(v.elapsedMs).toBe(75_000);
  });

  // ---- the clock stops for a person ------------------------------------
  //
  // `BudgetTracker.elapsed_sec` subtracts time parked on a question, so a run
  // is never killed for how long someone took to read a command. This function
  // counted plain wall clock and drew it against that same limit. Seen live:
  // a run parked 58 minutes on `npx next build` read **1:27:47 / 1:00:00** —
  // past its ceiling, still working, because the number and the limit beside
  // it were measuring two different things.

  it("does not count the time a question sat on screen", () => {
    const t0 = "2026-09-03T10:00:00+00:00";
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(1, 1) }, t0),
        entryAt("agent.request", { agentId: "a1", kind: "approval" }, "2026-09-03T10:01:00+00:00"),
        entryAt("agent.request.resolved", { agentId: "a1" }, "2026-09-03T10:59:00+00:00"),
        entryAt("agent.message", { agentId: "a1", usage: usage(1, 1) }, "2026-09-03T11:00:00+00:00"),
      ],
      budget: { timeout_sec: 3600 },
      startedAt: t0,
      endedAt: null,
      now: Date.parse("2026-09-03T11:00:00+00:00"),
    });
    // An hour of wall clock, 58 minutes of it waiting: two minutes of work.
    expect(v.elapsedMs).toBe(120_000);
    expect(v.parkedMs).toBe(58 * 60_000);
  });

  it("counts a question that is still on screen as still waiting", () => {
    const t0 = "2026-09-03T10:00:00+00:00";
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(1, 1) }, t0),
        entryAt("agent.request", { agentId: "a1", kind: "approval" }, "2026-09-03T10:01:00+00:00"),
      ],
      budget: { timeout_sec: 3600 },
      startedAt: t0,
      endedAt: null,
      now: Date.parse("2026-09-03T11:30:00+00:00"),
    });
    expect(v.elapsedMs).toBe(60_000);
    expect(v.parkedMs).toBe(89 * 60_000);
  });

  it("treats a wait inside a wait as one wait", () => {
    // Re-entrant, like the tracker: a tool approval inside a turn that is
    // itself inside a paused graph must not be subtracted twice.
    const t0 = "2026-09-03T10:00:00+00:00";
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(1, 1) }, t0),
        entryAt("agent.request", { agentId: "a1" }, "2026-09-03T10:00:10+00:00"),
        entryAt("agent.request", { agentId: "a2" }, "2026-09-03T10:00:20+00:00"),
        entryAt("agent.request.resolved", { agentId: "a2" }, "2026-09-03T10:00:30+00:00"),
        entryAt("agent.request.resolved", { agentId: "a1" }, "2026-09-03T10:00:40+00:00"),
      ],
      budget: null,
      startedAt: t0,
      endedAt: null,
      now: Date.parse("2026-09-03T10:00:50+00:00"),
    });
    // 50s wall, one 30s wait (10 -> 40), not 30 + 10.
    expect(v.parkedMs).toBe(30_000);
    expect(v.elapsedMs).toBe(20_000);
  });

  it("ends an unanswered wait at the ending, not at now", () => {
    // A run cancelled or reaped while parked publishes no `resolved`. Letting
    // that wait run to `now` would grow forever over a finished record.
    const t0 = "2026-09-03T10:00:00+00:00";
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(1, 1) }, t0),
        entryAt("agent.request", { agentId: "a1" }, "2026-09-03T10:00:30+00:00"),
        entryAt("mission.ended", { reason: "cancelled" }, "2026-09-03T10:01:00+00:00"),
      ],
      budget: null,
      startedAt: t0,
      endedAt: null,
      now: Date.parse("2026-09-03T18:00:00+00:00"),
    });
    expect(v.parkedMs).toBe(30_000);
    expect(v.elapsedMs).toBe(30_000);
  });

  it("gives the next round its own parked clock", () => {
    const t0 = "2026-09-03T10:00:00+00:00";
    const v = deriveVitals({
      events: [
        entryAt("agent.request", { agentId: "a1" }, "2026-09-03T10:00:10+00:00"),
        entryAt("agent.request.resolved", { agentId: "a1" }, "2026-09-03T10:30:00+00:00"),
        entryAt("mission.ended", { reason: "completed" }, "2026-09-03T10:31:00+00:00"),
        entryAt("user.message", { content: "more" }, "2026-09-03T12:00:00+00:00"),
      ],
      budget: null,
      startedAt: t0,
      endedAt: null,
      now: Date.parse("2026-09-03T12:00:20+00:00"),
    });
    // The previous round's half-hour wait is not this round's business.
    expect(v.parkedMs).toBe(0);
    expect(v.elapsedMs).toBe(20_000);
  });

  it("survives a timestamp it cannot read", () => {
    const v = deriveVitals({
      events: [],
      budget: null,
      startedAt: "not a date",
      endedAt: null,
    });
    expect(v.elapsedMs).toBe(0);
  });

  it("reports no ceiling when the mission carries none", () => {
    const v = deriveVitals({ events: [], budget: {}, startedAt: null, endedAt: null });
    expect(v.maxTokens).toBeNull();
    expect(v.timeoutMs).toBeNull();
  });
});

describe("how the numbers are written", () => {
  it("counts a duration down to the second, never rounding up", () => {
    expect(formatDuration(112_000)).toBe("1:52");
    expect(formatDuration(59_999)).toBe("0:59");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("keeps small token counts exact", () => {
    expect(formatTokens(418)).toBe("418");
    expect(formatTokens(4200)).toBe("4.2k");
    expect(formatTokens(3000)).toBe("3k");
  });


});

// ---- the whole conversation -------------------------------------------
//
// The round's counters reset when a round ends, and that is right: each round
// gets a fresh budget, so a round's spend is what belongs beside a round's
// limit. What it meant was that the panel forgot everything the moment a
// second question was asked — and a conversation is the thing a person is
// actually working on.
//
// These carry across rounds and are shown with **no limit**, because there is
// no mission-wide ceiling. A total beside a round's limit is the mistake that
// put 45,856 / 200,000 over a run killed at 200,811.

describe("totals for the whole mission", () => {
  const twoRounds = () => [
    entryAt("agent.message", { agentId: "a1", usage: usage(10, 10) }, "2026-09-03T10:00:00+00:00"),
    entryAt("mission.ended", { reason: "completed" }, "2026-09-03T10:01:00+00:00"),
    entryAt("user.message", { content: "more" }, "2026-09-03T12:00:00+00:00"),
    entryAt("agent.message", { agentId: "a1", usage: usage(5, 5) }, "2026-09-03T12:00:20+00:00"),
  ];

  it("keeps counting across a round boundary", () => {
    const v = deriveVitals({
      events: twoRounds(),
      budget: { max_tokens: 100, timeout_sec: 900 },
      startedAt: "2026-09-03T10:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-03T12:00:30+00:00"),
    });
    // The round on screen is the second one...
    expect(v.tokens).toBe(10);
    expect(v.replies).toBe(1);
    // ...and the conversation is both.
    expect(v.missionTokens).toBe(30);
    expect(v.missionReplies).toBe(2);
  });

  it("adds up the working time of every round, not the wall clock between them", () => {
    const v = deriveVitals({
      events: twoRounds(),
      budget: { timeout_sec: 900 },
      startedAt: "2026-09-03T10:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-03T12:00:30+00:00"),
    });
    // 60s of the first round plus 30s of the second. Not the two hours the
    // conversation sat waiting to be continued.
    expect(v.missionElapsedMs).toBe(90_000);
  });

  it("does not count time a round spent parked, in the total either", () => {
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(1, 1) }, "2026-09-03T10:00:00+00:00"),
        entryAt("agent.request", { agentId: "a1" }, "2026-09-03T10:00:10+00:00"),
        entryAt("agent.request.resolved", { agentId: "a1" }, "2026-09-03T10:00:50+00:00"),
        entryAt("mission.ended", { reason: "completed" }, "2026-09-03T10:01:00+00:00"),
        entryAt("user.message", { content: "more" }, "2026-09-03T10:02:00+00:00"),
      ],
      budget: null,
      startedAt: "2026-09-03T10:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-03T10:02:10+00:00"),
    });
    // 60s of round one minus its 40s wait, plus 10s of round two.
    expect(v.missionElapsedMs).toBe(30_000);
  });

  it("equals the round on a mission that has only had one", () => {
    const v = deriveVitals({
      events: [
        entryAt("agent.message", { agentId: "a1", usage: usage(7, 3) }, "2026-09-03T10:00:00+00:00"),
      ],
      budget: null,
      startedAt: "2026-09-03T10:00:00+00:00",
      endedAt: null,
      now: Date.parse("2026-09-03T10:00:05+00:00"),
    });
    expect(v.missionTokens).toBe(v.tokens);
    expect(v.missionReplies).toBe(v.replies);
    expect(v.missionElapsedMs).toBe(v.elapsedMs);
  });
});
