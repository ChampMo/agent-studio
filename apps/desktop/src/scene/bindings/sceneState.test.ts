/**
 * M5 proof: the scene degrades, it does not crash (PROJECT_BRIEF.md §12 M5, §8).
 *
 * The milestone's stated criterion is "an unrecognised status falls back to the
 * default pose without crashing". That is only checkable as a test because the
 * mapping is a pure function — the renderer draws whatever this returns, so
 * proving this proves the criterion without a canvas.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_POSE, poseFor, shapeFor } from "../animation/poses";
import { seatPositions } from "../engine/iso";
import { lookFor } from "../entities/palette";
import { deriveSceneState } from "./sceneState";

const ROSTER = [
  {
    agent_id: "a-lead",
    name: "Lead",
    seat_index: 0,
    role_in_team: "leader",
    model: "m1",
    avatar_config: { body: "slim", hair: "bun", outfit: "blazer", palette: "teal" },
  },
  {
    agent_id: "a-one",
    name: "One",
    seat_index: 1,
    role_in_team: "member",
    model: "m1",
    avatar_config: { body: "sturdy", hair: "buzz", outfit: "armor", palette: "ink" },
  },
];

let seq = 0;
function ev(type: string, payload: Record<string, unknown>) {
  seq += 1;
  return {
    event: {
      v: 1,
      id: `e-${seq}`,
      missionId: "m-1",
      seq,
      ts: "2026-08-31T00:00:00Z",
      draft: { type, payload },
    } as never,
  };
}

function derive(events: ReturnType<typeof ev>[], seats = 4) {
  return deriveSceneState({ roster: ROSTER as never, events, seats });
}

// ---- the M5 criterion ---------------------------------------------------

describe("an unrecognised status", () => {
  it("falls back to the default pose instead of throwing", () => {
    const state = derive([ev("agent.status", { agentId: "a-lead", status: "vibing" })]);
    expect(state.actors[0]!.pose).toBe(DEFAULT_POSE);
  });

  it("still resolves to a drawable shape", () => {
    // The renderer indexes the shape table directly; an unknown key here would
    // be `undefined` and the character would not draw at all.
    const shape = shapeFor(poseFor("teleporting"));
    expect(shape.caption).toBeTruthy();
    expect(Number.isFinite(shape.lean)).toBe(true);
  });

  it("does not throw for any value at all", () => {
    for (const status of [null, undefined, 42, {}, [], "", "DANCING"]) {
      expect(() => shapeFor(poseFor(status))).not.toThrow();
    }
  });
});

describe("an unknown avatar asset", () => {
  it("resolves to a real look rather than undefined", () => {
    // An asset added by a newer build. The catalogue is closed and validated
    // server-side, but the scene must survive reading a mission written later.
    const look = lookFor({ build: "gigantic", coat: "silver_mane", palette: "octarine" });
    expect(look.palette.fur).toBeTypeOf("number");
    expect(look.build.h).toBeGreaterThan(0);
    expect(look.coat.patch).toBeGreaterThanOrEqual(0);
  });

  it("still draws a cat for a run frozen on the human catalogue", () => {
    // `missions.roster_snapshot` was deliberately left alone by migration
    // 0019, so replaying an old run hands these slots straight in.
    //
    // What survives is the part the two catalogues happen to share. `outfit`
    // does, because a blazer is a blazer on a cat; `body` and `hair` do not,
    // because those slots were renamed, so they fall back — which is this
    // build honestly saying it has no art for what was recorded (§8), not a
    // migration quietly rewriting it (§5.1).
    const old = lookFor({ body: "slim", hair: "short", outfit: "blazer", palette: "slate" });
    expect(old.keys).toEqual({
      build: "lithe",
      coat: "tabby",
      outfit: "blazer",
      palette: "ginger",
    });
  });
});

describe("an unknown layout", () => {
  it("still produces one position per seat", () => {
    const positions = seatPositions("holodeck", 5);
    expect(positions).toHaveLength(5);
    expect(new Set(positions.map((p) => `${p.x},${p.y}`)).size).toBe(5);
  });

  it("keeps known desks in place when a layout gains seats", () => {
    const four = seatPositions("war_room", 4);
    const six = seatPositions("war_room", 6);
    expect(six.slice(0, 4)).toEqual(four);
    expect(six).toHaveLength(6);
  });
});

// ---- what the scene shows is what happened ------------------------------

describe("poses follow the event stream", () => {
  it("uses the latest status per agent", () => {
    const state = derive([
      ev("agent.status", { agentId: "a-one", status: "thinking" }),
      ev("agent.status", { agentId: "a-one", status: "working" }),
    ]);
    expect(state.actors.find((a) => a.agentId === "a-one")!.pose).toBe("working");
  });

  it("leaves an agent that has never reported at the default pose", () => {
    const state = derive([ev("agent.status", { agentId: "a-lead", status: "working" })]);
    expect(state.actors.find((a) => a.agentId === "a-one")!.pose).toBe(DEFAULT_POSE);
  });

  it("resets everyone when the mission ends", () => {
    // The reason this rule exists: a cancelled run is closed mid-thought and
    // never reaches `agent.status idle`. A scene waiting for one would leave a
    // character thinking for ever.
    const state = derive([
      ev("agent.status", { agentId: "a-lead", status: "thinking" }),
      ev("agent.status", { agentId: "a-one", status: "working" }),
      ev("mission.ended", { reason: "cancelled", summary: "stopped" }),
    ]);
    expect(state.actors.every((a) => a.pose === DEFAULT_POSE)).toBe(true);
    expect(state.endReason).toBe("cancelled");
  });
});

describe("the current task", () => {
  it("is attributed by reading the plan the leader broadcast", () => {
    const state = derive([
      ev("agent.message", {
        agentId: "a-lead",
        messageId: "plan",
        to: { kind: "broadcast" },
        content: "Plan:\n1. Gather sources → seat 1",
      }),
      ev("mission.progress", {
        taskId: "t1",
        label: "Gather sources",
        state: "running",
        done: 0,
        total: 1,
      }),
    ]);
    expect(state.actors.find((a) => a.agentId === "a-one")!.task).toBe("Gather sources");
    expect(state.actors.find((a) => a.agentId === "a-lead")!.task).toBeNull();
  });

  it("clears when the task finishes", () => {
    const state = derive([
      ev("agent.message", {
        agentId: "a-lead",
        messageId: "plan",
        to: { kind: "broadcast" },
        content: "Plan:\n1. Gather sources -> seat 1",
      }),
      ev("mission.progress", {
        taskId: "t1",
        label: "Gather sources",
        state: "running",
        done: 0,
        total: 1,
      }),
      ev("mission.progress", {
        taskId: "t1",
        label: "Gather sources",
        state: "done",
        done: 1,
        total: 1,
      }),
    ]);
    expect(state.actors.find((a) => a.agentId === "a-one")!.task).toBeNull();
  });
});

describe("the roster the scene draws", () => {
  it("comes from the snapshot, seats and avatars included", () => {
    // §5.1: a replay draws who actually did the work, not who has that id today.
    const state = derive([]);
    expect(state.actors.map((a) => a.seatIndex)).toEqual([0, 1]);
    expect(state.actors[0]!.isLeader).toBe(true);
    expect(state.actors[1]!.avatar.outfit).toBe("armor");
  });

  it("never shows fewer seats than there are people", () => {
    // A layout narrower than the team would leave someone with nowhere to sit.
    const state = derive([], 1);
    expect(state.seats).toBeGreaterThanOrEqual(ROSTER.length);
  });

  it("handles an empty mission without throwing", () => {
    expect(() => deriveSceneState({ roster: [], events: [], seats: 4 })).not.toThrow();
  });
});

/**
 * A mission can be continued, so `mission.ended` ends a round rather than the
 * log. Seen live: the scene captioned `round finished — crashed` — an ending
 * from an earlier round, hours old — over a team that was three tasks into its
 * next one, with every character still sat at their desk.
 *
 * `deriveVitals` already had this rule for its counters. The scene derives
 * per-round state from the same log and needed it too.
 */
describe("a continued run", () => {
  it("opens a new round on the first event after an ending", () => {
    const state = derive([
      ev("agent.status", { agentId: "a-lead", status: "thinking" }),
      ev("mission.ended", { reason: "crashed" }),
      ev("user.message", { content: "carry on" }),
      ev("agent.status", { agentId: "a-lead", status: "working" }),
    ]);
    expect(state.endReason).toBeNull();
    // And the room is theirs again rather than everyone sat back down.
    expect(state.actors[0]!.pose).toBe(poseFor("working"));
  });

  it("still reports an ending that is the last thing on the log", () => {
    const state = derive([
      ev("agent.status", { agentId: "a-lead", status: "thinking" }),
      ev("mission.ended", { reason: "completed" }),
    ]);
    expect(state.endReason).toBe("completed");
    expect(state.actors[0]!.pose).toBe(DEFAULT_POSE);
  });

  it("does not carry the previous round's task label into the next", () => {
    const state = derive([
      ev("mission.progress", { taskId: "t1", label: "Old work", state: "running" }),
      ev("mission.ended", { reason: "budget_exceeded" }),
      ev("user.message", { content: "carry on" }),
    ]);
    expect(state.actors.every((a) => a.task === null)).toBe(true);
  });
});
