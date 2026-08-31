/**
 * What is waiting on the user (PROJECT_BRIEF.md §7.3, §12 M6).
 *
 * Two sources, and both are needed:
 *
 * * **REST**, on startup. The question may have been asked by a process that no
 *   longer exists — that is the milestone's criterion. A client that only
 *   listened to the socket would never learn about it, and the mission would
 *   wait for ever with nobody aware of it.
 * * **The event stream**, while the app is open, so a question that arrives
 *   mid-run appears without polling.
 *
 * Answering goes back through REST, not the socket: the answer has to be
 * durable and routable to a mission this client may not even be watching.
 */
import { create } from "zustand";
import { api, type PendingRequest } from "../transport/rest";
import type { EventEnvelope } from "../transport/events.generated";

interface ApprovalState {
  pending: PendingRequest[];
  /** The request being answered right now, so a double click cannot answer
   *  twice — the backend refuses the second with a 409 either way (§7.3). */
  answering: string | null;
  /** Put off, not answered. The mission stays paused and the request stays in
   *  `pending`; only this window stops blocking on it, so the user can go and
   *  look at whatever they need in order to decide. */
  deferred: string[];
  error: string | null;

  refresh: () => Promise<void>;
  observe: (event: EventEnvelope, missionId: string | null) => void;
  answer: (requestId: string, reply: string) => Promise<void>;
  defer: (requestId: string) => void;
  resume: () => void;
  dismissError: () => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  pending: [],
  answering: null,
  deferred: [],
  error: null,

  refresh: async () => {
    try {
      const { requests } = await api.pendingRequests();
      set({ pending: requests });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  observe: (event, missionId) => {
    const p = event.draft.payload as Record<string, any>;
    if (event.draft.type === "agent.request") {
      const requestId = String(p.requestId ?? "");
      if (!requestId || get().pending.some((r) => r.requestId === requestId)) return;
      set((s) => ({
        pending: [
          ...s.pending,
          {
            missionId: missionId ?? "",
            requestId,
            goal: "",
            askedAt: event.ts,
            question: p.question ?? "",
            kind: p.kind ?? "question",
            options: p.options ?? null,
            agentId: p.agentId ?? null,
          },
        ],
      }));
    } else if (event.draft.type === "agent.request.resolved") {
      // Someone answered — possibly in another window, possibly this one. The
      // question is gone either way, and the modal has to close.
      const requestId = String(p.requestId ?? "");
      set((s) => ({ pending: s.pending.filter((r) => r.requestId !== requestId) }));
    }
  },

  answer: async (requestId, reply) => {
    if (get().answering) return;
    set({ answering: requestId, error: null });
    try {
      await api.resolveRequest(requestId, reply);
      set((s) => ({ pending: s.pending.filter((r) => r.requestId !== requestId) }));
    } catch (err) {
      // A 409 means it was already answered. Dropping it from the list is the
      // honest outcome: it is no longer waiting on anyone.
      set((s) => ({
        error: (err as Error).message,
        pending: s.pending.filter((r) => r.requestId !== requestId),
      }));
    } finally {
      set({ answering: null });
    }
  },

  defer: (requestId) =>
    set((s) => ({ deferred: [...new Set([...s.deferred, requestId])] })),

  /** Bring the deferred questions back. */
  resume: () => set({ deferred: [] }),

  dismissError: () => set({ error: null }),
}));
