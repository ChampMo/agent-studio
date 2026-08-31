/**
 * M7 proof: everything that moves is moving because of something on the log
 * (PROJECT_BRIEF.md §12 M7, §1.1, §8).
 *
 * Walking, the camera and the speech bubbles are the first things in this app
 * that could be pure decoration. They are not: a character's position is
 * derived state, the camera looks at a point a pure function chose, and a
 * bubble carries the agent's own words. Each of those is asserted here, along
 * with the failure that would be invisible on screen — a character walking
 * somewhere for a reason that never happened.
 */
import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../transport/events.generated";
import { BUBBLE_LIMIT, deriveSceneState } from "./sceneState";
import { cameraTarget, floorSpot, roomCentre, seatPositions, toScreen } from "../engine/iso";
import { FRESH_MS, shouldChime } from "../audio";

const ROSTER = [
  {
    agent_id: "a-lead",
    name: "Lead",
    seat_index: 0,
    role_in_team: "leader",
    model: "m1",
    avatar_config: {},
  },
  {
    agent_id: "a-1",
    name: "Worker",
    seat_index: 1,
    role_in_team: "member",
    model: "m1",
    avatar_config: {},
  },
];

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): { event: EventEnvelope } {
  seq += 1;
  return {
    event: {
      v: 1,
      id: `e-${seq}`,
      seq,
      ts: "2026-08-31T00:00:00Z",
      missionId: "m-1",
      draft: { type, payload },
    } as unknown as EventEnvelope,
  };
}

function scene(events: { event: EventEnvelope }[], streaming = {}) {
  return deriveSceneState({ roster: ROSTER, events, seats: 2, streaming });
}

const placeOf = (state: ReturnType<typeof scene>, id: string) =>
  state.actors.find((a) => a.agentId === id)?.place;

describe("who leaves their seat", () => {
  it("nobody, until the mission turns on someone", () => {
    seq = 0;
    const state = scene([ev("mission.started", { goal: "g" })]);
    expect(state.actors.map((a) => a.place)).toEqual(["seat", "seat"]);
    expect(state.focusAgentId).toBeNull();
  });

  it("the agent being waited on takes the floor, and sits back down when answered", () => {
    seq = 0;
    const asked = [
      ev("agent.request", { agentId: "a-lead", requestId: "r1", question: "ok?" }),
    ];
    expect(placeOf(scene(asked), "a-lead")).toBe("floor");
    expect(placeOf(scene(asked), "a-1")).toBe("seat");

    const answered = [
      ...asked,
      ev("agent.request.resolved", { requestId: "r1", answer: "approve" }),
    ];
    expect(placeOf(scene(answered), "a-lead")).toBe("seat");
    expect(scene(answered).focusAgentId).toBeNull();
  });

  it("the agent whose task is running takes the floor", () => {
    seq = 0;
    const events = [
      // The plan is where the seat assignment lives — the progress events carry
      // no owner (§2.1).
      ev("agent.message", { agentId: "a-lead", content: "Plan:\n1. Gather → seat 1" }),
      ev("mission.progress", { taskId: "t1", label: "Gather", state: "running", done: 0, total: 1 }),
    ];
    expect(placeOf(scene(events), "a-1")).toBe("floor");

    const done = [
      ...events,
      ev("mission.progress", { taskId: "t1", label: "Gather", state: "done", done: 1, total: 1 }),
    ];
    expect(placeOf(scene(done), "a-1")).toBe("seat");
  });

  it("stops describing the asker as waiting once it has an answer", () => {
    // The asker publishes `waiting` when it asks and publishes nothing when the
    // answer arrives, so the pose would otherwise outlive the question by the
    // whole rest of the run.
    seq = 0;
    const asked = [
      ev("agent.status", { agentId: "a-lead", status: "waiting" }),
      ev("agent.request", { agentId: "a-lead", requestId: "r1", question: "ok?" }),
    ];
    expect(scene(asked).actors.find((a) => a.agentId === "a-lead")?.pose).toBe("waiting");

    const answered = [
      ...asked,
      ev("agent.request.resolved", { requestId: "r1", answer: "approve" }),
    ];
    expect(scene(answered).actors.find((a) => a.agentId === "a-lead")?.pose).toBe("idle");

    // And a real status published afterwards still wins.
    const resumed = [
      ...answered,
      ev("agent.status", { agentId: "a-lead", status: "thinking" }),
    ];
    expect(scene(resumed).actors.find((a) => a.agentId === "a-lead")?.pose).toBe("thinking");
  });

  it("a question outranks a running task", () => {
    // Both are true at once when the gate opens mid-run. The room is about
    // whoever is being waited on.
    seq = 0;
    const events = [
      ev("agent.message", { agentId: "a-lead", content: "Plan:\n1. Gather → seat 1" }),
      ev("mission.progress", { taskId: "t1", label: "Gather", state: "running", done: 0, total: 1 }),
      ev("agent.request", { agentId: "a-lead", requestId: "r1", question: "ok?" }),
    ];
    expect(scene(events).focusAgentId).toBe("a-lead");
  });

  it("sits everyone down when the mission ends, even mid-question", () => {
    // A run cancelled while waiting leaves an unanswered request on the log for
    // ever. Someone standing at the front of an empty room is the scene
    // claiming a mission is still going.
    seq = 0;
    const events = [
      ev("agent.request", { agentId: "a-lead", requestId: "r1", question: "ok?" }),
      ev("mission.ended", { reason: "cancelled", summary: "stopped" }),
    ];
    const state = scene(events);
    expect(state.focusAgentId).toBeNull();
    expect(state.actors.map((a) => a.place)).toEqual(["seat", "seat"]);
  });

  it("puts nobody on the floor for an agent that is not in the roster", () => {
    // §8: the log can name an agent this snapshot does not have — an archived
    // teammate, a newer build. Nothing crashes and nobody moves.
    seq = 0;
    const state = scene([
      ev("agent.request", { agentId: "a-ghost", requestId: "r1", question: "ok?" }),
    ]);
    expect(state.focusAgentId).toBe("a-ghost");
    expect(state.actors.map((a) => a.place)).toEqual(["seat", "seat"]);
  });
});

describe("speech bubbles", () => {
  it("carries the agent's own words, and only for the latest speaker", () => {
    seq = 0;
    const events = [
      ev("agent.message", { agentId: "a-lead", content: "Here is the plan." }),
      ev("agent.message", { agentId: "a-1", content: "Found three sources." }),
    ];
    const state = scene(events);
    expect(state.actors.find((a) => a.agentId === "a-1")?.says).toBe("Found three sources.");
    expect(state.actors.find((a) => a.agentId === "a-lead")?.says).toBeNull();
  });

  it("shortens a long message instead of rewriting it", () => {
    seq = 0;
    const long = "x".repeat(BUBBLE_LIMIT + 50);
    const says = scene([ev("agent.message", { agentId: "a-1", content: long })]).actors.find(
      (a) => a.agentId === "a-1",
    )?.says;
    expect(says).toHaveLength(BUBBLE_LIMIT + 1); // the ellipsis
    expect(says?.endsWith("…")).toBe(true);
    expect(long.startsWith(says!.slice(0, -1))).toBe(true);
  });

  it("says nothing for an empty message", () => {
    seq = 0;
    const state = scene([ev("agent.message", { agentId: "a-1", content: "   " })]);
    expect(state.actors.find((a) => a.agentId === "a-1")?.says).toBeNull();
  });

  it("shows a reply while it is still being typed", () => {
    // Deltas name their author, so the bubble fills in live and the sequenced
    // message that follows replaces it with the same words (§7.1).
    seq = 0;
    const state = scene([ev("agent.status", { agentId: "a-1", status: "thinking" })], {
      "msg-1": { agentId: "a-1", text: "Half a sen" },
    });
    expect(state.actors.find((a) => a.agentId === "a-1")?.says).toBe("Half a sen");
  });

  it("clears every bubble when the mission ends", () => {
    seq = 0;
    const state = scene([
      ev("agent.message", { agentId: "a-1", content: "Found three sources." }),
      ev("mission.ended", { reason: "completed", summary: "done" }),
    ]);
    expect(state.actors.every((a) => a.says === null)).toBe(true);
  });
});

describe("the camera", () => {
  const positions = seatPositions("war_room", 4);

  it("looks at the middle of the room when nobody has the floor", () => {
    expect(cameraTarget(null, "seat", positions)).toEqual(roomCentre(positions));
  });

  it("looks at the front of the room at whoever has it", () => {
    const spot = floorSpot(positions);
    expect(cameraTarget(1, "floor", positions)).toEqual(toScreen(spot.x, spot.y));
  });

  it("looks at a seated subject's desk", () => {
    expect(cameraTarget(2, "seat", positions)).toEqual(
      toScreen(positions[2]!.x, positions[2]!.y),
    );
  });

  it("falls back to the room for a seat the layout does not have", () => {
    // §8 again: a team saved by a newer build with more seats than this one
    // knows must not send the camera into empty space.
    expect(cameraTarget(99, "seat", positions)).toEqual(roomCentre(positions));
  });

  it("has a front even for a layout with no desks at all", () => {
    expect(Number.isFinite(floorSpot([]).x)).toBe(true);
  });
});

describe("sound", () => {
  const now = Date.parse("2026-08-31T12:00:00Z");
  const at = (type: string, iso: string) =>
    ({
      v: 1,
      id: "e",
      seq: 1,
      ts: iso,
      missionId: "m",
      draft: { type, payload: {} },
    }) as unknown as EventEnvelope;

  it("chimes for something that just happened", () => {
    expect(shouldChime(at("agent.message", "2026-08-31T12:00:00Z"), now, false)).toBe(
      "message",
    );
    expect(shouldChime(at("agent.request", "2026-08-31T12:00:00Z"), now, false)).toBe(
      "request",
    );
  });

  it("is silent for a replay", () => {
    // Opening a finished mission from History pushes its whole log through the
    // same store. Thirty chimes at once for a run from last week.
    expect(shouldChime(at("mission.ended", "2026-08-31T12:00:00Z"), now, true)).toBeNull();
  });

  it("is silent for history a reconnect brought back", () => {
    // The socket resumes from seq 0, so old events arrive down the live path.
    const old = new Date(now - FRESH_MS - 1000).toISOString();
    expect(shouldChime(at("agent.message", old), now, false)).toBeNull();
  });

  it("is silent for an event this build cannot date", () => {
    expect(shouldChime(at("agent.message", "not a date"), now, false)).toBeNull();
  });

  it("is silent for event types it has no voice for", () => {
    expect(shouldChime(at("agent.status", "2026-08-31T12:00:00Z"), now, false)).toBeNull();
    expect(
      shouldChime(at("something.invented.later", "2026-08-31T12:00:00Z"), now, false),
    ).toBeNull();
  });
});
