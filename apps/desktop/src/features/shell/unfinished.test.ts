/**
 * Picking one task back up, instead of paying for the whole round again.
 *
 * A run that stops early leaves its plan half-executed. On the run this came
 * from, the task left over was `Review pages against component contracts` — a
 * verification task, which is both the kind that gets cut most often and the
 * kind whose absence matters most, since it is what would have said whether
 * the rest is true.
 */
import { describe, expect, it } from "vitest";

import { retryAllMessage, retryMessage, unfinishedTasks } from "./unfinished";

let seq = 0;
function ev(type: string, payload: Record<string, unknown>) {
  seq += 1;
  return {
    event: {
      v: 1,
      id: `e-${seq}`,
      missionId: "m-1",
      seq,
      ts: "2026-09-03T00:00:00Z",
      draft: { type, payload },
    },
    known: true,
    futureVersion: false,
  } as never;
}

function progress(id: string, label: string, state: string, instruction?: string) {
  return ev("mission.progress", {
    taskId: id,
    label,
    state,
    done: 0,
    total: 3,
    ...(instruction === undefined ? {} : { instruction }),
  });
}

describe("what a round did not finish", () => {
  it("keeps the tasks that failed and the ones that never started", () => {
    const left = unfinishedTasks([
      progress("t1", "Write the pages", "pending", "Write every route."),
      progress("t2", "Review the pages", "pending", "Check every import."),
      progress("t3", "Build it", "pending", "Run the build."),
      progress("t1", "Write the pages", "running"),
      progress("t1", "Write the pages", "done"),
      progress("t2", "Review the pages", "running"),
      progress("t2", "Review the pages", "failed"),
    ]);
    expect(left.map((t) => [t.id, t.state])).toEqual([
      ["t2", "failed"],
      ["t3", "pending"],
    ]);
  });

  it("carries the instruction the task was actually given", () => {
    const [task] = unfinishedTasks([
      progress("t1", "Review", "pending", "Check every import resolves."),
      progress("t1", "Review", "failed"),
    ]);
    expect(task!.instruction).toBe("Check every import resolves.");
    expect(retryMessage(task!)).toContain("Check every import resolves.");
  });

  it("does not offer to redo a task that is still running", () => {
    // It is working, not unfinished. Offering it would be offering to run the
    // same task twice at once.
    expect(
      unfinishedTasks([
        progress("t1", "Write", "pending", "go"),
        progress("t1", "Write", "running"),
      ]),
    ).toEqual([]);
  });

  it("forgets a previous round's plan when a new one starts", () => {
    // A task that failed two rounds ago was already answered by the rounds
    // after it, and offering to redo it would be offering to redo history.
    const left = unfinishedTasks([
      progress("t1", "Old work", "pending", "old"),
      progress("t1", "Old work", "failed"),
      ev("mission.ended", { reason: "budget_exceeded" }),
      ev("user.message", { content: "carry on" }),
      progress("t1", "New work", "pending", "new"),
      progress("t1", "New work", "failed"),
    ]);
    expect(left).toHaveLength(1);
    expect(left[0]!.title).toBe("New work");
  });

  it("still names a task from a round recorded before instructions were kept", () => {
    // The title is all there is, and a retry built from it is worth more than
    // no retry at all (§8).
    const [task] = unfinishedTasks([
      progress("t1", "Write NOTES.md", "pending"),
      progress("t1", "Write NOTES.md", "failed"),
    ]);
    expect(task!.instruction).toBe("");
    expect(retryMessage(task!)).toContain("Write NOTES.md");
  });

  it("says which of the two problems it was", () => {
    // A task that ran and came back empty needs a different approach; one that
    // never started needs room. Same word for both would hide that.
    const ran = retryMessage({
      id: "t1", title: "x", instruction: "y", state: "failed",
    });
    const never = retryMessage({
      id: "t2", title: "x", instruction: "y", state: "pending",
    });
    expect(ran).toContain("produced nothing usable");
    expect(never).toContain("never started");
  });
});

describe("the message a retry sends", () => {
  it("does not print the title twice when there is no instruction", () => {
    // Seen on the first real use: a round recorded before instructions were
    // kept has only the title, and the message read "Write NOTES.md" twice,
    // one line apart, which looks like a bug rather than emphasis.
    const text = retryMessage({
      id: "t1",
      title: "Write NOTES.md",
      instruction: "",
      state: "failed",
    });
    expect(text.split("Write NOTES.md").length - 1).toBe(1);
  });

  it("keeps both when the instruction says more than the title", () => {
    const text = retryMessage({
      id: "t1",
      title: "Review",
      instruction: "Check every import resolves to a file that exists.",
      state: "failed",
    });
    expect(text).toContain("Review");
    expect(text).toContain("Check every import resolves");
  });
});

describe("picking up everything that was left", () => {
  it("names every task and what it was told to do", () => {
    const text = retryAllMessage([
      { id: "t1", title: "Review", instruction: "Check the imports.", state: "failed" },
      { id: "t2", title: "Build", instruction: "Run next build.", state: "pending" },
    ]);
    expect(text).toContain("Review");
    expect(text).toContain("Check the imports.");
    expect(text).toContain("Build");
    expect(text).toContain("Run next build.");
  });

  it("keeps which of them ran and which never started", () => {
    // The one piece of diagnosis the round produced for free. A task that came
    // back empty needs a different approach; one that never started needs
    // room, and flattening both into "do these" throws that away.
    const text = retryAllMessage([
      { id: "t1", title: "Review", instruction: "", state: "failed" },
      { id: "t2", title: "Build", instruction: "", state: "pending" },
    ]);
    expect(text).toContain("ran and produced nothing usable");
    expect(text).toContain("never started");
  });

  it("does not repeat a title that is all the task has", () => {
    const text = retryAllMessage([
      { id: "t1", title: "Write NOTES.md", instruction: "", state: "failed" },
    ]);
    expect(text.split("Write NOTES.md").length - 1).toBe(1);
  });
});
