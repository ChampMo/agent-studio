/**
 * M6 proof, frontend half: a question outlives the window that asked it
 * (PROJECT_BRIEF.md §12 M6).
 *
 * The backend test proves the pause survives the *process*. This one covers
 * what the client has to do for that to be worth anything: find a question it
 * never saw asked, drop it the moment it is answered — including when someone
 * else answers it — and never re-raise a question while reading history.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "../transport/events.generated";

const pendingRequests = vi.fn();
const resolveRequest = vi.fn();

vi.mock("../transport/rest", () => ({
  api: {
    pendingRequests: () => pendingRequests(),
    resolveRequest: (id: string, answer: string) => resolveRequest(id, answer),
  },
}));

// Both are reached only when an answer resumes a mission, and both belong to
// other stores. Mocked so this file tests the decision — follow it, or leave it
// alone — rather than the machinery on the far side of it.
const attach = vi.fn();
const eventState = { missionId: null as string | null, replaying: false, attach };
const loadMissions = vi.fn();

vi.mock("./eventStore", () => ({
  useEventStore: { getState: () => eventState },
}));
vi.mock("./historyStore", () => ({
  useHistoryStore: { getState: () => ({ load: loadMissions }) },
}));

const { useApprovalStore } = await import("./approvalStore");

function envelope(
  type: string,
  payload: Record<string, unknown>,
  missionId = "m-1",
): EventEnvelope {
  return {
    v: 1,
    id: `e-${Math.random()}`,
    seq: 1,
    ts: "2026-08-31T00:00:00Z",
    missionId,
    draft: { type, payload },
  } as unknown as EventEnvelope;
}

beforeEach(() => {
  useApprovalStore.setState({
    pending: [],
    answering: null,
    error: null,
  });
  pendingRequests.mockReset();
  resolveRequest.mockReset();
  attach.mockReset();
  loadMissions.mockReset();
  eventState.missionId = null;
  eventState.replaying = false;
});

describe("finding what is already waiting", () => {
  it("asks the backend, because the question may predate this window", async () => {
    // Nothing arrives on the socket: the mission paused in a session that has
    // since been closed. Without this call it would wait for ever.
    pendingRequests.mockResolvedValue({
      requests: [
        {
          missionId: "m-old",
          requestId: "req-1",
          goal: "Investigate.",
          askedAt: "2026-08-30T10:00:00Z",
          question: "Approve this plan?",
          kind: "approval",
          options: ["approve", "reject"],
        },
      ],
    });

    await useApprovalStore.getState().refresh();

    const pending = useApprovalStore.getState().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.missionId).toBe("m-old");
    expect(pending[0]?.question).toContain("Approve");
  });

  it("keeps the app usable when the backend cannot be reached", async () => {
    pendingRequests.mockRejectedValue(new Error("connection refused"));
    await useApprovalStore.getState().refresh();
    expect(useApprovalStore.getState().error).toBe("connection refused");
    expect(useApprovalStore.getState().pending).toEqual([]);
  });
});

describe("the live stream", () => {
  it("raises a question that arrives mid-run", () => {
    useApprovalStore
      .getState()
      .observe(
        envelope("agent.request", {
          requestId: "req-2",
          kind: "approval",
          question: "ok?",
          agentId: "a-lead",
          options: ["approve", "reject"],
        }),
        "m-1",
      );
    expect(useApprovalStore.getState().pending.map((r) => r.requestId)).toEqual([
      "req-2",
    ]);
  });

  it("does not raise the same question twice on a reconnect", () => {
    // The socket replays history from seq 0 after a drop (§6.2), so the same
    // `agent.request` is delivered again. Two modals for one question would be
    // a way to answer the wrong one.
    const event = envelope("agent.request", {
      requestId: "req-3",
      kind: "approval",
      question: "ok?",
    });
    useApprovalStore.getState().observe(event, "m-1");
    useApprovalStore.getState().observe(event, "m-1");
    expect(useApprovalStore.getState().pending).toHaveLength(1);
  });

  it("drops a question its mission never got round to answering", () => {
    // Cancelled, out of budget, or reaped as crashed while parked on the
    // question. No `agent.request.resolved` is ever published, and the backend
    // has already cleared `pending_request` with the ending — so anything left
    // here is the sidebar marking a dead run as waiting on you, over an answer
    // box whose answer would come back 409.
    useApprovalStore
      .getState()
      .observe(envelope("agent.request", { requestId: "req-8", question: "ok?" }), "m-1");
    useApprovalStore
      .getState()
      .observe(envelope("mission.ended", { reason: "cancelled" }), "m-1");
    expect(useApprovalStore.getState().pending).toEqual([]);
  });

  it("leaves another run's question alone when one ends", () => {
    // Two runs can be parked at once, and only one of them ended.
    useApprovalStore
      .getState()
      .observe(
        envelope("agent.request", { requestId: "req-9", question: "ok?" }, "m-2"),
        "m-2",
      );
    useApprovalStore
      .getState()
      .observe(envelope("mission.ended", { reason: "completed" }, "m-1"), "m-1");
    expect(useApprovalStore.getState().pending.map((r) => r.requestId)).toEqual([
      "req-9",
    ]);
  });

  it("drops a question answered somewhere else", () => {
    useApprovalStore
      .getState()
      .observe(envelope("agent.request", { requestId: "req-4", question: "ok?" }), "m-1");
    useApprovalStore
      .getState()
      .observe(
        envelope("agent.request.resolved", {
          requestId: "req-4",
          answer: "approve",
          resolvedBy: "user",
        }),
        "m-1",
      );
    expect(useApprovalStore.getState().pending).toEqual([]);
  });
});

describe("answering", () => {
  it("removes the question once the backend has it", async () => {
    useApprovalStore
      .getState()
      .observe(envelope("agent.request", { requestId: "req-5", question: "ok?" }), "m-1");
    resolveRequest.mockResolvedValue({ missionId: "m-1", resumed: true });

    await useApprovalStore.getState().answer("req-5", "approve");

    expect(resolveRequest).toHaveBeenCalledWith("req-5", "approve");
    expect(useApprovalStore.getState().pending).toEqual([]);
    expect(useApprovalStore.getState().answering).toBeNull();
  });

  it("follows the run it just restarted", async () => {
    // A mission parked on a question has no task driving it, so opening it
    // reads it back off the log. Answering starts it again — and without this
    // the window keeps showing the record: "Working" over a run that has since
    // finished, and a transcript ending at the question.
    eventState.missionId = "m-1";
    eventState.replaying = true;
    useApprovalStore
      .getState()
      .observe(envelope("agent.request", { requestId: "req-a", question: "ok?" }), "m-1");
    resolveRequest.mockResolvedValue({ missionId: "m-1", resumed: true });

    await useApprovalStore.getState().answer("req-a", "approve");

    expect(attach).toHaveBeenCalledWith("m-1");
  });

  it("does not drag the window off the run being read", async () => {
    // The question can belong to a mission other than the one on screen —
    // that is the whole reason the sidebar marks it. Answering it must not
    // replace what the reader is looking at.
    eventState.missionId = "m-other";
    eventState.replaying = true;
    resolveRequest.mockResolvedValue({ missionId: "m-1", resumed: true });

    await useApprovalStore.getState().answer("req-b", "approve");

    expect(attach).not.toHaveBeenCalled();
    // The list still has to learn that a run changed state.
    expect(loadMissions).toHaveBeenCalled();
  });

  it("leaves a live stream alone", async () => {
    // Already attached: `attach` would resubscribe from seq 0 and rebuild the
    // whole timeline for nothing.
    eventState.missionId = "m-1";
    eventState.replaying = false;
    resolveRequest.mockResolvedValue({ missionId: "m-1", resumed: true });

    await useApprovalStore.getState().answer("req-c", "approve");

    expect(attach).not.toHaveBeenCalled();
  });

  it("clears a question the backend says is no longer outstanding", async () => {
    // A 409: already answered, or the mission ended. Leaving it on screen would
    // invite a second answer to a question nobody is waiting on.
    useApprovalStore
      .getState()
      .observe(envelope("agent.request", { requestId: "req-6", question: "ok?" }), "m-1");
    resolveRequest.mockRejectedValue(new Error("no mission is waiting on this request"));

    await useApprovalStore.getState().answer("req-6", "approve");

    expect(useApprovalStore.getState().pending).toEqual([]);
    expect(useApprovalStore.getState().error).toContain("no mission is waiting");
  });

  it("keeps a question until it is actually answered", () => {
    // There is no way to put one aside any more. `defer` existed to move a
    // modal off the timeline you needed to read; the card sits beside the
    // timeline now, so the only exits are an answer and the run ending.
    useApprovalStore
      .getState()
      .observe(envelope("agent.request", { requestId: "req-7", question: "ok?" }), "m-1");

    expect(useApprovalStore.getState().pending).toHaveLength(1);
    expect("defer" in useApprovalStore.getState()).toBe(false);

    useApprovalStore
      .getState()
      .observe(
        envelope("agent.request.resolved", { requestId: "req-7", answer: "approve" }),
        "m-1",
      );
    expect(useApprovalStore.getState().pending).toEqual([]);
  });
});
