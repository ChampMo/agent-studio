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

const { useApprovalStore } = await import("./approvalStore");

function envelope(type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    v: 1,
    id: `e-${Math.random()}`,
    seq: 1,
    ts: "2026-08-31T00:00:00Z",
    missionId: "m-1",
    draft: { type, payload },
  } as unknown as EventEnvelope;
}

beforeEach(() => {
  useApprovalStore.setState({
    pending: [],
    answering: null,
    deferred: [],
    error: null,
  });
  pendingRequests.mockReset();
  resolveRequest.mockReset();
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

  it("puts a question off without answering it", () => {
    useApprovalStore
      .getState()
      .observe(envelope("agent.request", { requestId: "req-7", question: "ok?" }), "m-1");
    useApprovalStore.getState().defer("req-7");

    // Deferring hides the modal. It does not answer, so the mission is still
    // paused and the request is still there to come back to.
    expect(useApprovalStore.getState().pending).toHaveLength(1);
    expect(useApprovalStore.getState().deferred).toEqual(["req-7"]);

    useApprovalStore.getState().resume();
    expect(useApprovalStore.getState().deferred).toEqual([]);
  });
});
