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
 *
 * There is no "defer". It existed to get a modal out of the way so the timeline
 * underneath could be read; the question lives *in* the timeline now, at the
 * moment it was asked, so there is nothing to move. A question leaves this list
 * by being answered, or by its mission ending — never by being put aside,
 * because the mission stays paused either way and a hidden pause is a run that
 * looks stuck for no reason.
 *
 * This list is also what the sidebar marks a run with. That made the second of
 * those exits load-bearing: a mission cancelled while it was waiting publishes
 * no `agent.request.resolved`, and the entry used to sit here until something
 * happened to call `refresh()` — a triangle on a dead run, over an answer box
 * whose answer the backend would 409.
 */
import { create } from "zustand";
import { api, type PendingRequest } from "../transport/rest";
// A cycle: `eventStore` imports this module too. Safe, and safe for the same
// reason that one is — neither touches the other at module scope, only inside
// a function, by which time both have finished evaluating.
import { useEventStore } from "./eventStore";
import { useHistoryStore } from "./historyStore";
import type { EventEnvelope } from "../transport/events.generated";

interface ApprovalState {
  pending: PendingRequest[];
  /** The request being answered right now, so a double click cannot answer
   *  twice — the backend refuses the second with a 409 either way (§7.3). */
  answering: string | null;
  error: string | null;

  refresh: () => Promise<void>;
  observe: (event: EventEnvelope, missionId: string | null) => void;
  answer: (requestId: string, reply: string) => Promise<void>;
  dismissError: () => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  pending: [],
  answering: null,
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
      // question is gone either way, and the controls have to go with it.
      const requestId = String(p.requestId ?? "");
      set((s) => ({ pending: s.pending.filter((r) => r.requestId !== requestId) }));
    } else if (event.draft.type === "mission.ended") {
      // A run that ends while parked on a question — cancelled, out of budget,
      // reaped as crashed — never answers it. The backend agrees: `_finish`
      // clears `pending_request` with the ending, so anything still listed here
      // for that mission is this client disagreeing with the server about
      // whether a question is live.
      const ended = event.missionId ?? missionId;
      if (ended) {
        set((s) => ({ pending: s.pending.filter((r) => r.missionId !== ended) }));
      }
    }
  },

  answer: async (requestId, reply) => {
    if (get().answering) return;
    set({ answering: requestId, error: null });
    try {
      const { missionId, resumed } = await api.resolveRequest(requestId, reply);
      set((s) => ({ pending: s.pending.filter((r) => r.requestId !== requestId) }));
      if (resumed) resumeWatching(missionId);
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

  dismissError: () => set({ error: null }),
}));

/**
 * Follow a mission that has just started running again.
 *
 * A mission parked on a question has no task driving it, so the backend does
 * not report it as `running` and opening it reads it back off the log — which
 * is right, and is how the question got answered from a screen the socket was
 * not attached to.
 *
 * Answering restarts it, and at that moment the record on screen stops being
 * the present. Seen live: the run resumed, finished, and the window went on
 * showing "Working", a sidebar row saying "Waiting on you", and a transcript
 * ending at `Ilse is waiting` — every one of them describing a minute that was
 * over (§1).
 *
 * `attach` subscribes from seq 0, so the replayed history arrives again and the
 * run continues live in the same stream. Only when this client was reading that
 * mission: answering a question belonging to some other run must not drag the
 * window away from what is in front of you.
 */
function resumeWatching(missionId: string): void {
  const events = useEventStore.getState();
  if (events.missionId === missionId && events.replaying) {
    events.attach(missionId);
  }
  // The list's rows are a fetched snapshot, and one of them still says this run
  // is waiting on an answer it has just been given.
  void useHistoryStore.getState().load();
}
