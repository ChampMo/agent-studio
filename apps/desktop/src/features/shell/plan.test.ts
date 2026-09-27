/**
 * Every round's plan, from one log.
 *
 * A continued run appends to the same log, so the earlier plans are already
 * there — nothing is stored for this, and nothing should be (§2.1).
 *
 * The shapes here come off the real `PARADOX.ART` run: a first round that
 * ended `failed` with one task failed, and a second that planned five more.
 */
import { describe, expect, it } from "vitest";

import { planProgress, planRounds } from "./plan";

let seq = 0;
function ev(type: string, payload: Record<string, unknown>) {
  seq += 1;
  return {
    event: {
      v: 1,
      id: `e-${seq}`,
      missionId: "m-1",
      seq,
      ts: "2026-09-26T00:00:00Z",
      draft: { type, payload },
    },
    known: true,
    futureVersion: false,
  } as never;
}

const task = (id: string, label: string, state: string) =>
  ev("mission.progress", { taskId: id, label, state, done: 0, total: 2 });

const ROUND_ONE = [
  ev("user.message", { content: "Build the store." }),
  task("t1", "UX spec", "pending"),
  task("t2", "Build the shell", "pending"),
  task("t1", "UX spec", "done"),
  task("t2", "Build the shell", "failed"),
  ev("mission.ended", { reason: "failed", summary: "nothing was built" }),
];

const ROUND_TWO = [
  ev("user.message", { content: "Carry on with the shell." }),
  task("t9", "Build index.html", "pending"),
  task("t9", "Build index.html", "done"),
];

describe("the rounds a run has had", () => {
  it("keeps each round's own plan", () => {
    const rounds = planRounds([...ROUND_ONE, ...ROUND_TWO]);

    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.tasks.map((t) => t.title)).toEqual([
      "UX spec",
      "Build the shell",
    ]);
    expect(rounds[1]!.tasks.map((t) => t.title)).toEqual(["Build index.html"]);
  });

  it("counts each round on its own", () => {
    const [one, two] = planRounds([...ROUND_ONE, ...ROUND_TWO]);
    expect([one!.done, one!.failed]).toEqual([1, 1]);
    expect([two!.done, two!.failed]).toEqual([1, 0]);
  });

  it("remembers how a finished round ended, and that the last one has not", () => {
    const [one, two] = planRounds([...ROUND_ONE, ...ROUND_TWO]);
    expect(one!.endReason).toBe("failed");
    // No ending yet is what marks the round still going — the picker shows it
    // as "this round" rather than inventing an outcome for it.
    expect(two!.endReason).toBeNull();
  });

  it("keeps which limit stopped a round, for the label that names it", () => {
    const [one] = planRounds([
      task("t1", "Write it", "done"),
      ev("mission.ended", { reason: "budget_exceeded", limit: "tokens" }),
    ]);
    expect([one!.endReason, one!.endLimit]).toEqual(["budget_exceeded", "tokens"]);
  });

  it("keeps what each round was asked", () => {
    const [one, two] = planRounds([...ROUND_ONE, ...ROUND_TWO]);
    expect(one!.asked).toBe("Build the store.");
    expect(two!.asked).toBe("Carry on with the shell.");
  });

  it("keeps a round that died before it had a plan", () => {
    // The round that failed in planning is exactly the one worth looking at,
    // so it is a round with no tasks rather than a round that never happened.
    const rounds = planRounds([
      ...ROUND_ONE,
      ev("user.message", { content: "again" }),
      ev("error", { code: "planning_failed", message: "...", recoverable: false }),
      ev("mission.ended", { reason: "failed" }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[1]!.tasks).toEqual([]);
    expect(rounds[1]!.asked).toBe("again");
  });

  it("keeps a state this build has never heard of out of the finished count", () => {
    const [one] = planRounds([task("t1", "Odd", "teleported")]);
    expect(one!.tasks[0]!.state).toBe("pending");
    expect(one!.done).toBe(0);
  });
});

describe("the plan on screen", () => {
  it("is the last round, so the panel and the history cannot disagree", () => {
    const events = [...ROUND_ONE, ...ROUND_TWO];
    const rounds = planRounds(events);
    const now = planProgress(events);

    expect(now.tasks).toEqual(rounds[rounds.length - 1]!.tasks);
    expect(now.done).toBe(1);
  });

  it("is empty before anything is planned", () => {
    expect(planProgress([]).tasks).toEqual([]);
  });
});

/**
 * A task this app cut off is counted apart from one that failed.
 *
 * Asked for twice in the same words: a round that runs out is fine, a plan
 * the model wrote for itself coming back `failed` is not. On the run behind
 * that report every red task was the app stopping the turn at a ration it had
 * set, so the panel was reporting the app's own rationing as the plan going
 * wrong.
 */
describe("a stopped task", () => {
  it("is not counted as failed, and is not counted as still to do", () => {
    const plan = planProgress([
      task("t1", "Scope brief", "done"),
      task("t2", "Build Hero", "stopped"),
      task("t3", "QA", "pending"),
    ]);
    expect(plan.done).toBe(1);
    expect(plan.failed).toBe(0);
    expect(plan.stopped).toBe(1);
    // `left` is what is genuinely outstanding. A stopped task will not run
    // again in this round, so counting it as left would report work as
    // pending that the round has already given up on.
    expect(plan.left).toBe(1);
  });

  it("survives a state this build has never heard of", () => {
    // §8 — a later build may send something this one does not know, and the
    // panel must still show the task rather than dropping it.
    const plan = planProgress([
      task("t1", "Scope brief", "done"),
      task("t2", "Something new", "teleported"),
    ]);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]?.title).toBe("Something new");
  });
});
