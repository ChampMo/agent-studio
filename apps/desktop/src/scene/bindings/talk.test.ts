/**
 * A line between two cats is a claim that they are talking *now*.
 *
 * Most of this file is about when that claim would be false — refusing to draw
 * is the interesting part. The first block exists because of a real mistake:
 * the derivation originally read `agent.message.to`, which on every real run is
 * only ever `user` or `broadcast`. It could never draw the agent-to-agent line
 * it was written for, and it *looked* like it worked because broadcasts still
 * appeared.
 */
import { describe, expect, it } from "vitest";

import { WINDOW_MS, ageOf, recentTalk, resolveName } from "./talk";
import type { SequencedEntry } from "../../stores/eventStore";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

const ROSTER = [
  { agentId: "a1", name: "Project Manager (PM)" },
  { agentId: "a2", name: "Developer (Dev)" },
  { agentId: "a3", name: "Tester (QA Engineer)" },
];

function ev(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  secondsAgo = 0,
): SequencedEntry {
  return {
    event: {
      v: 1,
      id,
      missionId: "m1",
      seq: 1,
      ts: new Date(NOW - secondsAgo * 1000).toISOString(),
      draft: { type, payload },
    },
    known: true,
    futureVersion: false,
  } as unknown as SequencedEntry;
}

const sent = (id: string, from: string, to: unknown, secondsAgo = 0) =>
  ev(
    id,
    "agent.tool.start",
    { agentId: from, tool: "send_message", input: { to, content: "hi" } },
    secondsAgo,
  );

const said = (id: string, from: string, to: unknown, secondsAgo = 0) =>
  ev(id, "agent.message", { agentId: from, content: "hi", to }, secondsAgo);

const live = (events: SequencedEntry[]) =>
  recentTalk({ events, roster: ROSTER, now: NOW, replaying: false });

describe("agent to agent is the send_message tool", () => {
  it("draws a line for a tool call, by name", () => {
    // `send_message` addresses people by name, not id — this is the whole
    // reason the roster has to be passed in.
    expect(live([sent("e1", "a2", "Tester")])).toEqual([
      { id: "e1", from: "a2", to: "a3", kind: "agent", at: NOW },
    ]);
  });

  it("does not draw one for an agent's own reply", () => {
    // `agent.message.to` never carries an agent on a real run; a second source
    // for the same fact would be a second answer to it (§2.1).
    expect(live([said("e1", "a2", { kind: "agent", id: "a3" })])).toEqual([]);
  });

  it("skips a send_message with no recipient", () => {
    // A real shape on the log: the model left the field out. There is nobody
    // to draw a line to.
    expect(live([sent("e1", "a2", undefined)])).toEqual([]);
  });

  it("never draws a line to a name two teammates answer to", () => {
    // Delivering to the wrong person and reporting success is the worst
    // failure the mailbox has; an arrow to the wrong cat is its picture.
    const twins = [
      { agentId: "x1", name: "Mara" },
      { agentId: "x2", name: "Mara" },
    ];
    expect(
      recentTalk({
        events: [sent("e1", "x1", "Mara")],
        roster: twins,
        now: NOW,
        replaying: false,
      }),
    ).toEqual([]);
  });

  it("never draws a loop back to the sender", () => {
    expect(live([sent("e1", "a2", "Developer")])).toEqual([]);
  });
});

describe("resolving a name the way the mailbox does", () => {
  it("prefers exact, then prefix, then contains", () => {
    expect(resolveName("Developer (Dev)", ROSTER)).toBe("a2");
    expect(resolveName("Developer", ROSTER)).toBe("a2");
    expect(resolveName("QA", ROSTER)).toBe("a3");
  });

  it("takes an agent id as well", () => {
    expect(resolveName("a1", ROSTER)).toBe("a1");
  });

  it("returns null for nobody, and for everybody", () => {
    expect(resolveName("Nobody", ROSTER)).toBeNull();
    // "e" is inside all three names: ambiguous, so no line.
    expect(resolveName("e", ROSTER)).toBeNull();
  });
});

describe("to the user and to the team", () => {
  it("keeps them apart", () => {
    // Different things, drawn differently: one leaves the room, one goes to
    // everyone. Collapsing them would make the picture say less than the log.
    expect(
      live([
        said("e1", "a1", { kind: "user" }),
        said("e2", "a1", { kind: "broadcast" }),
      ]).map((l) => l.kind),
    ).toEqual(["user", "broadcast"]);
  });

  it("ignores a recipient shape it does not know", () => {
    expect(live([said("e1", "a1", { kind: "carrier-pigeon" })])).toEqual([]);
  });
});

describe("when it refuses to draw", () => {
  it("draws nothing at all while replaying", () => {
    const events = [sent("e1", "a2", "Tester")];
    expect(
      recentTalk({ events, roster: ROSTER, now: NOW, replaying: true }),
    ).toEqual([]);
  });

  it("drops anything older than the window", () => {
    expect(live([sent("e1", "a2", "Tester", 60)])).toEqual([]);
  });

  it("keeps something sent a moment ago", () => {
    expect(live([sent("e1", "a2", "Tester", 2)])).toHaveLength(1);
  });

  it("skips a timestamp it cannot read, and one from the future", () => {
    const broken = sent("e1", "a2", "Tester");
    (broken.event as unknown as { ts: string }).ts = "not a date";
    expect(live([broken])).toEqual([]);
    expect(live([sent("e2", "a2", "Tester", -600)])).toEqual([]);
  });
});

describe("fading", () => {
  it("is 0 when just said and never past 1", () => {
    const line = {
      id: "e1",
      from: "a1",
      to: "a2",
      kind: "agent" as const,
      at: NOW,
    };
    expect(ageOf(line, NOW)).toBe(0);
    expect(ageOf(line, NOW + WINDOW_MS)).toBe(1);
    expect(ageOf(line, NOW + WINDOW_MS * 4)).toBe(1);
  });
});
