/**
 * M1 proof #6: the frontend degrades, it does not crash (PROJECT_BRIEF.md §8).
 *
 * §8 says this must be a test case rather than a comment, and §13 keeps
 * component tests out until M4 — which is exactly why the rule lives in a pure
 * function. These run with no DOM and no React.
 *
 * The scenario being defended against is not hypothetical: mission_events is
 * append-only forever, so this build will eventually read rows written by a
 * newer one.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_POSES,
  DEFAULT_POSE,
  KNOWN_EVENT_TYPES,
  KNOWN_SCHEMA_VERSION,
  decodeFrame,
  describe as describeEvent,
  poseFromEvent,
  toEnum,
  toPose,
} from "./decode";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    v: KNOWN_SCHEMA_VERSION,
    id: "evt-1",
    missionId: "m-1",
    seq: 1,
    ts: "2026-08-31T00:00:00Z",
    draft: { type: "agent.thought", payload: { agentId: "a1", text: "hm" } },
    ...overrides,
  };
}

describe("the known-type list comes from the contract", () => {
  it("is derived from the schema, not hand-maintained", () => {
    // A copied list is a second source of truth and drifts the first time
    // someone adds an event type (§2.2).
    expect(KNOWN_EVENT_TYPES.has("agent.message")).toBe(true);
    expect(KNOWN_EVENT_TYPES.has("mission.ended")).toBe(true);
    expect(KNOWN_EVENT_TYPES.has("agent.request.resolved")).toBe(true);
    // Added with images (§12 M9.3), and this count is why the addition could
    // not be made quietly on one side of the contract.
    expect(KNOWN_EVENT_TYPES.has("attachment.added")).toBe(true);
    // What a tool-only round cost. Added because the budget guard counted
    // those tokens and the log did not, so a run stopped at 200,000 showed
    // 7,540 on its own timeline (§1).
    expect(KNOWN_EVENT_TYPES.has("agent.usage")).toBe(true);
    expect(KNOWN_EVENT_TYPES.size).toBe(16);
  });
});

describe("unknown event types", () => {
  it("decode as valid but unknown, so the timeline can show a fallback row", () => {
    const result = decodeFrame(
      envelope({ draft: { type: "agent.teleported", payload: { to: "mars" } } }),
    );
    expect(result.kind).toBe("sequenced");
    if (result.kind !== "sequenced") return;
    expect(result.known).toBe(false);
    // Crucially it is not dropped: something real happened and the record of it
    // must survive even when this build cannot name it.
    expect(result.event.seq).toBe(1);
  });

  it("still produce a readable line", () => {
    const result = decodeFrame(
      envelope({ draft: { type: "agent.teleported", payload: {} } }),
    );
    if (result.kind !== "sequenced") throw new Error("expected sequenced");
    expect(describeEvent(result.event)).toBe("agent.teleported");
  });
});

describe("unknown enum values", () => {
  it("fall back to the default pose instead of throwing", () => {
    expect(toPose("dancing")).toBe(DEFAULT_POSE);
    expect(toPose(undefined)).toBe(DEFAULT_POSE);
    expect(toPose(42)).toBe(DEFAULT_POSE);
    for (const pose of AGENT_POSES) expect(toPose(pose)).toBe(pose);
  });

  it("fall back through poseFromEvent, which is what the scene will call", () => {
    const result = decodeFrame(
      envelope({
        draft: { type: "agent.status", payload: { agentId: "a1", status: "vibing" } },
      }),
    );
    if (result.kind !== "sequenced") throw new Error("expected sequenced");
    expect(poseFromEvent(result.event)).toBe(DEFAULT_POSE);
  });

  it("fall back to a neutral value for any enum", () => {
    const reasons = ["completed", "failed", "cancelled"] as const;
    expect(toEnum("teleported", reasons, "failed")).toBe("failed");
    expect(toEnum("completed", reasons, "failed")).toBe("completed");
  });
});

describe("a newer schema version", () => {
  it("is flagged but still rendered from its known fields", () => {
    const result = decodeFrame(
      envelope({
        v: KNOWN_SCHEMA_VERSION + 5,
        draft: {
          type: "agent.message",
          payload: {
            agentId: "a1",
            messageId: "m",
            to: { kind: "user" },
            content: "hello",
            // A field this build has never heard of must not break the ones it has.
            sentiment: "cheerful",
          },
        },
      }),
    );
    expect(result.kind).toBe("sequenced");
    if (result.kind !== "sequenced") return;
    expect(result.futureVersion).toBe(true);
    expect(result.known).toBe(true);
    expect(describeEvent(result.event)).toContain("hello");
  });

  it("does not flag the current version", () => {
    const result = decodeFrame(envelope());
    if (result.kind !== "sequenced") throw new Error("expected sequenced");
    expect(result.futureVersion).toBe(false);
  });
});

describe("ephemeral frames", () => {
  it("decode without a seq, because they never have one", () => {
    const result = decodeFrame({
      channel: "ephemeral",
      type: "agent.message.delta",
      missionId: "m-1",
      agentId: "a1",
      messageId: "msg-1",
      index: 0,
      text: "hi",
    });
    expect(result.kind).toBe("ephemeral");
    if (result.kind !== "ephemeral") return;
    expect(result.frame.messageId).toBe("msg-1");
    expect("seq" in result.frame).toBe(false);
  });

  it("are checked before seq, or every delta would look malformed", () => {
    // Regression guard: ordering the checks the other way round classifies the
    // entire delta channel as broken (§7.1).
    const result = decodeFrame({
      channel: "ephemeral",
      type: "agent.message.delta",
      missionId: "m",
      agentId: "a",
      messageId: "x",
      index: 3,
      text: "chunk",
    });
    expect(result.kind).not.toBe("malformed");
  });
});

describe("malformed frames", () => {
  it("are reported, never thrown", () => {
    // One bad frame must not be able to tear down a live stream.
    for (const bad of [null, undefined, 42, "text", [], {}, { seq: "one" }]) {
      expect(() => decodeFrame(bad)).not.toThrow();
      expect(decodeFrame(bad).kind).toBe("malformed");
    }
  });

  it("include a reason so the cause is visible rather than guessed", () => {
    const result = decodeFrame({ id: "x", seq: 1, v: 1, missionId: "m", ts: "t" });
    if (result.kind !== "malformed") throw new Error("expected malformed");
    expect(result.reason).toContain("draft.type");
  });
});

describe("agent attribution", () => {
  it("names the agent from the mission's frozen roster", () => {
    // The resolver is passed in rather than read from the agents table: a
    // replay must show who did the work, not who has that id today (§5.1).
    const result = decodeFrame(
      envelope({
        draft: {
          type: "agent.message",
          payload: {
            agentId: "a-7",
            messageId: "m",
            to: { kind: "user" },
            content: "found three sources",
          },
        },
      }),
    );
    if (result.kind !== "sequenced") throw new Error("expected sequenced");

    const asRecorded = describeEvent(result.event, (id) =>
      id === "a-7" ? "Mira Vale" : id,
    );
    expect(asRecorded).toBe("Mira Vale: found three sources");
  });

  it("falls back to the raw id when the roster has no entry", () => {
    // An agent removed from the snapshot, or a malformed one: the line stays
    // readable rather than saying "undefined".
    const result = decodeFrame(
      envelope({
        draft: { type: "agent.status", payload: { agentId: "ghost", status: "idle" } },
      }),
    );
    if (result.kind !== "sequenced") throw new Error("expected sequenced");
    expect(describeEvent(result.event)).toBe("ghost is idle");
  });

  it("does not attribute a user message to an agent", () => {
    const result = decodeFrame(
      envelope({ draft: { type: "user.message", payload: { content: "go" } } }),
    );
    if (result.kind !== "sequenced") throw new Error("expected sequenced");
    expect(describeEvent(result.event, () => "Mira")).toBe("go");
  });
});

describe("describe()", () => {
  it("never throws on a payload missing its fields", () => {
    for (const type of KNOWN_EVENT_TYPES) {
      const result = decodeFrame(envelope({ draft: { type, payload: {} } }));
      if (result.kind !== "sequenced") throw new Error(`expected sequenced for ${type}`);
      expect(() => describeEvent(result.event)).not.toThrow();
    }
  });
});

describe("the workspace on the timeline", () => {
  it("says where a mission was working", () => {
    // §16.2: the timeline and the replay have to be able to answer "where were
    // files being written?", not only the panel that was open at the time.
    const line = describeEvent(
      {
        draft: {
          type: "mission.started",
          payload: { kind: "mission", goal: "Fix the tests", workspaceRoot: "C:/work/app" },
        },
      } as never,
    );
    expect(line).toContain("C:/work/app");
    expect(line).toContain("Fix the tests");
  });

  it("says nothing extra for a mission that had no workspace", () => {
    const line = describeEvent(
      { draft: { type: "mission.started", payload: { kind: "chat", goal: "hello" } } } as never,
    );
    expect(line).toBe("Mission started — hello");
  });
});

describe("who ran a tool", () => {
  it("says when the endpoint ran it rather than this app", () => {
    // §16.8: a provider-side search never passed the approval gate and its
    // input was never redacted. The line must not read like one that did.
    const line = describeEvent(
      {
        draft: {
          type: "agent.tool.start",
          payload: { agentId: "a-1", callId: "c", tool: "web_search", origin: "provider" },
        },
      } as never,
      () => "Scout",
    );
    expect(line).toContain("endpoint ran");
    expect(line).not.toBe("Scout calls web_search");
  });

  it("reads normally for a tool this app ran", () => {
    const line = describeEvent(
      {
        draft: {
          type: "agent.tool.start",
          payload: { agentId: "a-1", callId: "c", tool: "read_file", origin: "client" },
        },
      } as never,
      () => "Scout",
    );
    expect(line).toBe("Scout calls read_file");
  });
});
