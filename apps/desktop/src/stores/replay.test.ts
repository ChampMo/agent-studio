/**
 * M6 proof: a replay is the same run, not a second interpretation of it
 * (PROJECT_BRIEF.md §12 M6, §2.1, §8).
 *
 * Replaying reads rows off `mission_events` and pushes them through the same
 * decoder and the same store the socket feeds. That is what makes the timeline
 * and the scene show a finished mission exactly as they showed it live — and it
 * is checkable here, because both paths end in the same state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const missionEvents = vi.fn();

vi.mock("../transport/rest", () => ({
  api: {
    missionEvents: (id: string) => missionEvents(id),
    pendingRequests: async () => ({ requests: [] }),
    resolveRequest: async () => ({ missionId: "m", resumed: true }),
  },
}));

const { useEventStore } = await import("./eventStore");
const { useApprovalStore } = await import("./approvalStore");
const { decodeFrame } = await import("../transport/decode");
const { deriveSceneState } = await import("../scene/bindings/sceneState");

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
const SEATS = 2;

let seq = 0;
function row(type: string, payload: Record<string, unknown>) {
  seq += 1;
  return {
    v: 1,
    id: `e-${seq}`,
    seq,
    ts: "2026-08-31T00:00:00Z",
    missionId: "m-old",
    draft: { type, payload },
  };
}

/** A finished run, as the log holds it: a question, its answer, and the work. */
function recordedRun() {
  seq = 0;
  return [
    row("mission.started", { goal: "Investigate.", teamId: null }),
    row("agent.status", { agentId: "a-lead", status: "thinking" }),
    row("agent.request", {
      agentId: "a-lead",
      requestId: "req-old",
      kind: "approval",
      question: "Approve this plan?",
      options: ["approve", "reject"],
    }),
    row("agent.request.resolved", {
      requestId: "req-old",
      answer: "approve",
      resolvedBy: "user",
    }),
    row("agent.status", { agentId: "a-1", status: "working" }),
    row("mission.ended", { reason: "completed", summary: "done" }),
  ];
}

beforeEach(() => {
  useEventStore.setState({
    missionId: null,
    events: [],
    malformed: [],
    streaming: {},
    endReason: null,
    replaying: false,
  });
  useApprovalStore.setState({ pending: [], answering: null, error: null });
  missionEvents.mockReset();
});

describe("replaying a finished mission", () => {
  it("derives the same state the live stream derived", async () => {
    const recorded = recordedRun();

    // The live run: frames off the socket, through the decoder, into the store.
    // `ingest` buffers to the next frame — attaching to a run replays its whole
    // history as one socket message per event, and applying those one at a time
    // made the transcript type itself in — so the flush is asked for directly
    // rather than waiting on an animation frame that a test runner never fires.
    for (const frame of recorded) useEventStore.getState().ingest(decodeFrame(frame));
    useEventStore.getState().applyPending();
    const live = useEventStore.getState().events;
    const scene = (events: typeof live) =>
      deriveSceneState({ roster: ROSTER, events, seats: SEATS });
    const liveScene = scene(live);

    // The same run, hours later, read back off the log.
    useEventStore.setState({ events: [], endReason: null });
    missionEvents.mockResolvedValue({ events: recorded });
    await useEventStore.getState().replay("m-old");

    const replayed = useEventStore.getState().events;
    expect(replayed.map((e) => e.event.id)).toEqual(live.map((e) => e.event.id));
    expect(scene(replayed)).toEqual(liveScene);
    expect(useEventStore.getState().endReason).toBe("completed");
    expect(useEventStore.getState().replaying).toBe(true);
  });

  it("does not re-ask a question from a run that is over", async () => {
    // The nastiest shape: a mission cancelled while it was still waiting. Its
    // log ends with an unanswered `agent.request`, so a client that treated
    // replayed events like live ones would raise a modal for a dead mission —
    // and answering it would come back a 409 from a backend that agrees the
    // question is gone.
    seq = 0;
    missionEvents.mockResolvedValue({
      events: [
        row("agent.request", {
          agentId: "a-lead",
          requestId: "req-abandoned",
          kind: "approval",
          question: "Approve this plan?",
        }),
        row("mission.ended", { reason: "cancelled", summary: "stopped by the user" }),
      ],
    });

    await useEventStore.getState().replay("m-old");

    expect(useApprovalStore.getState().pending).toEqual([]);
    // The question is still *on the timeline* — it happened, and the record
    // says so. It is simply not something anyone is being asked now.
    expect(
      useEventStore
        .getState()
        .events.some((e) => e.event.draft.type === "agent.request"),
    ).toBe(true);
  });

  it("survives a row written by a newer build", async () => {
    // §8: the log is append-only forever, so today's build will read rows it
    // has never heard of. A replay that threw would make old missions
    // unopenable after any schema change.
    const recorded = recordedRun();
    recorded.splice(2, 0, {
      ...row("something.invented.later", { whatever: true }),
      v: 99,
    } as any);
    missionEvents.mockResolvedValue({ events: [...recorded, { nonsense: true }] });

    await useEventStore.getState().replay("m-old");

    const { events, malformed } = useEventStore.getState();
    expect(events.some((e) => !e.known)).toBe(true);
    expect(events.some((e) => e.futureVersion)).toBe(true);
    // The unreadable frame is kept as such rather than dropped silently.
    expect(malformed).toHaveLength(1);
  });
});

/**
 * Opening a run that has been going a while delivers its whole history as one
 * socket message per event — 729 of them on a real run. Applied one at a time
 * that is 729 renders over a growing array, and the transcript visibly typed
 * itself in: opening a run looked like watching a replay of it.
 *
 * React batches updates inside one task and these arrive in a task each, so
 * the batching has to be ours.
 */
describe("a burst of frames", () => {
  it("is buffered rather than applied one at a time", () => {
    const recorded = recordedRun();
    useEventStore.setState({ events: [], endReason: null });

    for (const frame of recorded) useEventStore.getState().ingest(decodeFrame(frame));
    // Nothing has been applied yet: the frame has not come round.
    expect(useEventStore.getState().events).toHaveLength(0);

    useEventStore.getState().applyPending();
    expect(useEventStore.getState().events).toHaveLength(recorded.length);
  });

  it("throws the buffer away when the window moves to another run", () => {
    // Otherwise frames from the run you just left would land on the one you
    // just opened, which is the worst possible place for them.
    const recorded = recordedRun();
    useEventStore.setState({ events: [], endReason: null });
    for (const frame of recorded) useEventStore.getState().ingest(decodeFrame(frame));

    useEventStore.getState().detach();
    useEventStore.getState().applyPending();
    expect(useEventStore.getState().events).toHaveLength(0);
  });
});
