/**
 * Which moments in a run are offered as somewhere to go back to.
 *
 * This exists because of one mistake: the first version read `ev.type`, and
 * the envelope nests the event under `draft`. That is not a crash — it is
 * `undefined`, matching nothing, so the dialog reported "this run has no
 * recorded file changes" over a run with 48 events and three saved versions of
 * a file. The same shape as the watcher script that missed an approval for
 * forty minutes earlier in this project.
 */
import { describe, expect, it } from "vitest";

import { pointsFrom } from "./RewindDialog";
import type { SequencedEntry } from "../../stores/eventStore";

function entry(seq: number, type: string, payload: Record<string, unknown>) {
  return {
    event: {
      v: 1,
      id: `e${seq}`,
      missionId: "m1",
      seq,
      ts: "2026-09-03T11:16:38.000000+00:00",
      draft: { type, payload },
    },
    known: true,
    futureVersion: false,
  } as unknown as SequencedEntry;
}

describe("points to rewind to", () => {
  it("reads through the envelope, not off the top of it", () => {
    const points = pointsFrom([
      entry(2, "user.message", { content: "build the page" }),
    ]);
    expect(points).toEqual([
      {
        seq: 2,
        label: "build the page",
        ts: "2026-09-03T11:16:38.000000+00:00",
      },
    ]);
  });

  it("offers each task where it started, by the name the schema uses", () => {
    // `label`. The first version of both this test and the code said `title`,
    // so the test passed over code that dropped every task from the list — a
    // test written from the same assumption as the code proves nothing. These
    // payloads are copied from a real run's log.
    const points = pointsFrom([
      entry(8, "mission.progress", {
        taskId: "t1",
        label: "Create NOTE.md",
        state: "running",
        done: 0,
        total: 2,
      }),
      // Not where one *finished*: that is not a moment anybody means by
      // "before it went wrong".
      entry(20, "mission.progress", {
        taskId: "t1",
        label: "Create NOTE.md",
        state: "done",
        done: 1,
        total: 2,
      }),
      // Nor the announcement, which comes before any work and would offer the
      // same instant twice over.
      entry(5, "mission.progress", {
        taskId: "t1",
        label: "Create NOTE.md",
        state: "pending",
        done: 0,
        total: 2,
      }),
    ]);
    expect(points.map((p) => [p.seq, p.label])).toEqual([
      [8, "Create NOTE.md"],
    ]);
  });

  it("ignores everything else in the log", () => {
    expect(
      pointsFrom([
        entry(9, "agent.status", { agentId: "a1", status: "thinking" }),
        entry(12, "agent.tool.start", { callId: "c1", tool: "write_file" }),
      ]),
    ).toEqual([]);
  });

  it("names a message with no words rather than showing a blank row", () => {
    expect(
      pointsFrom([entry(2, "user.message", { content: "" })])[0]!.label,
    ).toBe("a message");
  });
});
