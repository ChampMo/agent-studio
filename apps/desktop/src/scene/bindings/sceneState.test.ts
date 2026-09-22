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
import { chooseArt, pathsFor, restingLayers } from "../entities/catArt";
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
    const look = lookFor({
      breed: "silver_mane",
      size: "gigantic",
      headwear: "crown",
      glasses: "x-ray",
      collar: "spiked",
    });
    expect(look.breed.fur).toBeTypeOf("number");
    expect(look.breed.layer).toBeTypeOf("string");
    expect(look.size.h).toBeGreaterThan(0);
    // `none` is first in each list, so a cat with an unreadable accessory is a
    // plain cat rather than one wearing something this build had to invent.
    expect(look.keys.headwear).toBe("none");
    expect(look.keys.glasses).toBe("none");
    expect(look.keys.collar).toBe("none");
  });

  it("still draws a cat for a run frozen on an older catalogue", () => {
    // `missions.roster_snapshot` has been left alone by every avatar migration
    // — 0019 through 0024 — so replaying an old run hands these slots
    // straight in.
    //
    // Nothing survives this time, and that is the honest outcome rather than a
    // regression: the four-slot names were all replaced, so every one falls
    // back. This build has no art for what was recorded and says so by drawing
    // the default cat (§8), instead of a migration quietly rewriting the
    // record to suit it (§5.1).
    const old = lookFor({ build: "lithe", coat: "patched", outfit: "blazer", palette: "smoke" });
    expect(old.keys).toEqual({
      breed: "marmalade",
      size: "normal",
      headwear: "none",
      glasses: "none",
      collar: "none",
    });
  });

  it("draws a bare cat for a `prop` this side deliberately cannot read", () => {
    // The slot that became two. Splitting it is the migration's job and only
    // the migration's: this side would have to keep its own copy of
    // `PROP_SPLIT` to know whether `prop: "cap"` meant a hat or glasses, and
    // two copies of one table is how they come to disagree (§2.1). So a
    // config the migration has not been over draws a cat wearing nothing.
    const stale = lookFor({ breed: "bombay", size: "fat", prop: "cap" });
    expect(stale.keys.headwear).toBe("none");
    expect(stale.keys.glasses).toBe("none");
    // What it *can* read is still read exactly.
    expect(stale.keys.breed).toBe("bombay");
    expect(stale.keys.size).toBe("fat");
  });

  it("keeps a snapshot it can read exactly, and wears both at once", () => {
    // The other half of the same promise: a snapshot this build *can* read is
    // drawn as it was recorded, not normalised toward anything. And the whole
    // point of two slots — a cat in a cap and glasses keeps both.
    const now = lookFor({
      breed: "bombay",
      size: "fat",
      headwear: "cap_brown",
      glasses: "teal",
    });
    expect(now.keys).toEqual({
      breed: "bombay",
      size: "fat",
      headwear: "cap_brown",
      glasses: "teal",
      collar: "none",
    });
    expect(now.breed.layer).toBe("sleek");
  });

  it("falls back for a size the catalogue no longer draws", () => {
    // `plump` was one of five; there are two now. Nothing is left that means
    // "a bit round", so it lands on the default rather than on a guess (§8).
    expect(lookFor({ breed: "bombay", size: "plump" }).keys.size).toBe("normal");
  });

  it("reads the one-slot build's `cat` as the breed it always was", () => {
    // That catalogue existed for one build and reached a database. The values
    // never changed, so a config it wrote names a cat this build can draw —
    // and gets it, rather than falling back over spelling.
    const one = lookFor({ cat: "marmalade" });
    expect(one.keys.breed).toBe("marmalade");
  });
});

describe("which files a cat is drawn from", () => {
  const has =
    (...drawn: string[]) =>
    (path: string) =>
      drawn.includes(path);
  const ALL = () => true;
  /** An avatar's slots, with everything not named left bare. */
  const keys = (over: Partial<Parameters<typeof pathsFor>[0]> = {}) => ({
    breed: "bombay",
    size: "normal",
    headwear: "none",
    glasses: "none",
    collar: "none",
    ...over,
  });

  it("prefers the drawing made for this breed at this size", () => {
    expect(pathsFor(keys({ size: "fat" })).faceCandidates).toEqual([
      "/art/cats/face/bombay-fat.png",
      "/art/cats/face/bombay-normal.png",
    ]);
  });

  it("asks for no second file at the size the cat was drawn at", () => {
    // `normal` is the drawing as drawn, so a separate candidate for it would
    // be the same picture twice (§2.1).
    expect(pathsFor(keys()).faceCandidates).toEqual([
      "/art/cats/face/bombay-normal.png",
    ]);
  });

  it("takes the eyes from the breed and the mouth from nobody", () => {
    // The artist drew four sets of eyes and one mouth, and they are genuinely
    // different eyes - marmalade black, siamese blue, bombay gold. The mouth
    // lives in its own folder and is shared, so its path carries no breed.
    const a = pathsFor(keys());
    const b = pathsFor(keys({ breed: "siamese" }));
    expect(a.eyes).toEqual([
      "/art/cats/eyes/bombay-open.png",
      "/art/cats/eyes/bombay-close.png",
    ]);
    expect(b.eyes[0]).toBe("/art/cats/eyes/siamese-open.png");
    expect(a.mouth).toEqual(b.mouth);
    expect(a.mouth).toEqual([
      "/art/cats/mouth/close.png",
      "/art/cats/mouth/open.png",
    ]);
  });

  it("asks for nothing where the choice was to wear nothing", () => {
    const bare = pathsFor(keys());
    expect(bare.collar).toBeNull();
    expect(bare.headwear).toBeNull();
    expect(bare.glasses).toBeNull();
    const dressed = pathsFor(
      keys({ headwear: "cap_brown", glasses: "teal", collar: "red" }),
    );
    expect(dressed.collar).toBe("/art/cats/collar/red.png");
    expect(dressed.headwear).toBe("/art/cats/headwear/cap_brown.png");
    expect(dressed.glasses).toBe("/art/cats/glasses/teal.png");
  });

  it("uses the size drawing and does not squash it as well", () => {
    // Squashing art that was drawn fat would make the same cat fat twice.
    const art = chooseArt(pathsFor(keys({ size: "fat" })), ALL);
    expect(art.face).toBe("/art/cats/face/bombay-fat.png");
    expect(art.scaled).toBe(false);
  });

  it("falls back to the plain cat and squashes that instead", () => {
    // The honest half-drawn state: a size nobody has drawn yet still has to
    // look different from the other, or the slot claims to do something it
    // does not (§1.1).
    const art = chooseArt(
      pathsFor(keys({ size: "fat" })),
      has("/art/cats/face/bombay-normal.png"),
    );
    expect(art.face).toBe("/art/cats/face/bombay-normal.png");
    expect(art.scaled).toBe(true);
  });

  it("drops one worn thing without losing the others", () => {
    const art = chooseArt(
      pathsFor(keys({ headwear: "cap_brown", glasses: "teal", collar: "red" })),
      has(
        "/art/cats/face/bombay-normal.png",
        "/art/cats/collar/red.png",
        "/art/cats/glasses/teal.png",
      ),
    );
    expect(art.collar).toBe("/art/cats/collar/red.png");
    expect(art.glasses).toBe("/art/cats/glasses/teal.png");
    expect(art.headwear).toBeNull();
  });

  it("drops a frame pair whole when only half of it was drawn", () => {
    // The opposite rule to the one above, and the reason it exists: with only
    // `open.png` on disk the cat would sit permanently open-mouthed, which
    // reads as *this agent is speaking* when nothing on the log said so
    // (§1). Half a blink is the same claim about the eyes.
    const art = chooseArt(
      pathsFor(keys()),
      has(
        "/art/cats/face/bombay-normal.png",
        "/art/cats/mouth/open.png",
        "/art/cats/eyes/bombay-open.png",
      ),
    );
    expect(art.face).not.toBeNull();
    expect(art.mouth).toEqual([]);
    expect(art.eyes).toEqual([]);
  });

  it("claims no face at all for a cat nobody has drawn", () => {
    // Null rather than a path, so the caller composites the sprite layers
    // instead of pointing an <img> at a file that is not there.
    const art = chooseArt(
      pathsFor(keys({ headwear: "cap_brown", collar: "red" })),
      () => false,
    );
    expect(art.face).toBeNull();
    expect(art.collar).toBeNull();
    expect(art.scaled).toBe(false);
    expect(restingLayers(art)).toEqual([]);
  });

  it("stacks the resting layers face first and glasses last", () => {
    // Paint order is decided once, here, because the delivered ink boxes make
    // it load-bearing: eyes and mouth overlap, the collar hangs below the
    // face's own bottom edge, and a head bow's ribbon reaches the top of the
    // glasses — 34 pixels, and the rim is what covers it.
    const art = chooseArt(
      pathsFor(keys({ headwear: "bow_red", glasses: "teal", collar: "red" })),
      ALL,
    );
    expect(restingLayers(art)).toEqual([
      "/art/cats/face/bombay-normal.png",
      "/art/cats/eyes/bombay-open.png",
      "/art/cats/mouth/close.png",
      "/art/cats/collar/red.png",
      "/art/cats/headwear/bow_red.png",
      "/art/cats/glasses/teal.png",
    ]);
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

// ---- the tool on the desk ----------------------------------------------

describe("the tool on the desk", () => {
  const start = (agentId: string, callId: string, tool: string) =>
    ev("agent.tool.start", { agentId, callId, tool, input: {} });
  const end = (agentId: string, callId: string) =>
    ev("agent.tool.end", { agentId, callId, ok: true, summary: "", durationMs: 1 });

  it("is the tool whose call has started and not ended", () => {
    const state = derive([start("a-one", "c1", "web_search")]);
    expect(state.actors[1]!.activeTool).toBe("web_search");
    expect(state.actors[0]!.activeTool).toBeNull();
  });

  it("leaves the desk when the call ends", () => {
    const state = derive([start("a-one", "c1", "web_search"), end("a-one", "c1")]);
    expect(state.actors[1]!.activeTool).toBeNull();
  });

  it("shows the newest of two open calls, and the other once that one ends", () => {
    const both = [start("a-one", "c1", "grep"), start("a-one", "c2", "bash")];
    expect(derive(both).actors[1]!.activeTool).toBe("bash");
    expect(derive([...both, end("a-one", "c2")]).actors[1]!.activeTool).toBe("grep");
  });

  it("is cleared by the round ending, even over a dangling start", () => {
    // A cancelled run is closed mid-call and never writes the end. The start
    // was true when written; a replay must not keep the dish turning for ever.
    const state = derive([
      start("a-one", "c1", "web_fetch"),
      ev("mission.ended", { reason: "cancelled" }),
    ]);
    expect(state.actors[1]!.activeTool).toBeNull();
  });

  it("does not carry a dangling start into the next round", () => {
    const state = derive([
      start("a-one", "c1", "web_fetch"),
      ev("mission.ended", { reason: "cancelled" }),
      ev("agent.status", { agentId: "a-lead", status: "thinking" }),
    ]);
    expect(state.actors[1]!.activeTool).toBeNull();
  });

  it("passes a tool this build has never heard of through unchanged", () => {
    // The renderer draws nothing for it rather than a guess (§8); what it
    // must not do is turn it into a different tool.
    const state = derive([start("a-one", "c1", "teleport")]);
    expect(state.actors[1]!.activeTool).toBe("teleport");
  });

  it("ignores an end whose start it never saw", () => {
    expect(derive([end("a-one", "c9")]).actors[1]!.activeTool).toBeNull();
  });
});

// ---- things thrown across the room ------------------------------------

describe("what gets thrown", () => {
  const plan = () =>
    ev("agent.message", { agentId: "a-lead", content: "Plan:\n1. Gather → seat 1" });
  const progress = (state: string) =>
    ev("mission.progress", { taskId: "t1", label: "Gather", state, done: 0, total: 1 });

  it("hands a task from the leader to its owner, and back when it is done", () => {
    const state = derive([plan(), progress("pending"), progress("running"), progress("done")]);
    expect(state.throws.map((t) => [t.kind, t.from, t.to])).toEqual([
      ["assign", "a-lead", "a-one"],
      ["done", "a-one", "a-lead"],
    ]);
  });

  it("sends a failed task back as failed", () => {
    const state = derive([plan(), progress("pending"), progress("failed")]);
    expect(state.throws.map((t) => t.kind)).toEqual(["assign", "failed"]);
  });

  it("throws a question toward the front of the room", () => {
    const state = derive([ev("agent.request", { agentId: "a-one", requestId: "r", question: "?" })]);
    expect(state.throws).toEqual([expect.objectContaining({ kind: "request", from: "a-one", to: "front" })]);
  });

  it("throws a message at the teammate the name resolves to, and at nobody otherwise", () => {
    const send = (to: string) =>
      ev("agent.tool.start", { agentId: "a-lead", callId: "c", tool: "send_message", input: { to } });
    expect(derive([send("One")]).throws[0]).toEqual(expect.objectContaining({ kind: "message", to: "a-one" }));
    expect(derive([send("on")]).throws[0]?.to).toBe("a-one");
    expect(derive([send("Nobody")]).throws).toEqual([]);
  });

  it("throws a note from the person at the one cat it was for", () => {
    const state = derive([ev("user.message", { content: "hi", to: "a-one" })]);
    expect(state.throws[0]).toEqual(expect.objectContaining({ from: "front", to: "a-one" }));
    expect(derive([ev("user.message", { content: "hi" })]).throws).toEqual([]);
  });

  it("carries the seq and timestamp, so the renderer can tell fresh from replayed", () => {
    const state = derive([ev("agent.request", { agentId: "a-one", requestId: "r", question: "?" })]);
    expect(state.throws[0]!.seq).toBeGreaterThan(0);
    expect(state.throws[0]!.ts).toBe("2026-08-31T00:00:00Z");
  });
});

describe("a plan that names people", () => {
  it("gives the task to the member with that name, as the backend now writes it", () => {
    const state = derive([
      ev("agent.message", { agentId: "a-lead", content: "Plan:\n1. Gather → One" }),
      ev("mission.progress", { taskId: "t1", label: "Gather", state: "running", done: 0, total: 1 }),
    ]);
    expect(state.actors[1]!.task).toBe("Gather");
    expect(state.focusAgentId).toBe("a-one");
  });

  it("gives nobody a task for a name that is not on the roster", () => {
    const state = derive([
      ev("agent.message", { agentId: "a-lead", content: "Plan:\n1. Gather → Ghost" }),
      ev("mission.progress", { taskId: "t1", label: "Gather", state: "running", done: 0, total: 1 }),
    ]);
    expect(state.actors.every((a) => a.task === null)).toBe(true);
  });
});
