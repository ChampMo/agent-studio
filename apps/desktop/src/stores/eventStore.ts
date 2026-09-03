/**
 * The single consumer of the event stream (PROJECT_BRIEF.md §2.1).
 *
 * Both readers of an event go through here: the timeline today, and
 * `scene/bindings` in M5. Neither component subscribes to the socket itself —
 * that is what keeps the two views showing the same run rather than two
 * slightly different interpretations of it.
 */
import { create } from "zustand";
import { decodeFrame, type Decoded } from "../transport/decode";
import { api } from "../transport/rest";
import { useApprovalStore } from "./approvalStore";
import type { EventEnvelope } from "../transport/events.generated";
import { EventSocket, type ConnectionState } from "../transport/ws";

export interface SequencedEntry {
  event: EventEnvelope;
  known: boolean;
  futureVersion: boolean;
}

export interface StreamingMessage {
  agentId: string;
  text: string;
}

export interface MalformedEntry {
  raw: unknown;
  reason: string;
  at: number;
}

interface EventState {
  missionId: string | null;
  connection: ConnectionState;
  events: SequencedEntry[];
  /** Frames this build could not read at all. Surfaced, never swallowed (§8). */
  malformed: MalformedEntry[];
  /** Partial text per messageId, assembled from deltas while a reply streams.
   *  Carries the author as well: the scene has to know whose speech bubble is
   *  being typed, and the `agent.message` naming them only arrives at the end. */
  streaming: Record<string, StreamingMessage>;
  endReason: string | null;
  /** Which ceiling, when the round ended on one. Absent on rounds recorded
   *  before the field existed, which keep the general phrase (§8). */
  endLimit: string | null;
  /** True while showing a finished run read back off the log, not a live one.
   *  The events are identical; what differs is that nothing more will arrive. */
  replaying: boolean;

  attach: (missionId: string) => void;
  replay: (missionId: string) => Promise<void>;
  detach: () => void;
  reset: () => void;
  ingest: (decoded: Decoded) => void;
  /** Apply everything buffered by `ingest`, now. Called on the next frame,
   *  and directly by tests that want the effect of a frame without waiting
   *  for one. */
  applyPending: () => void;
  /** One frame, applied. The body `ingest` used to be. */
  apply: (decoded: Decoded) => void;
}

let socket: EventSocket | null = null;

/**
 * Frames waiting to be applied together, and the thing that applies them.
 *
 * `requestAnimationFrame` rather than a timer: the buffer exists so the screen
 * is not asked to change more often than it can, and a frame is exactly that
 * period. Falls back to a microtask where there is no rAF — a test runner,
 * or a hidden tab, where rAF does not fire at all and events would otherwise
 * pile up unapplied until the tab was looked at again.
 */
let pending: Decoded[] = [];

const flushPending = (() => {
  let frame: number | null = null;
  let timer: number | null = null;

  const clear = () => {
    if (frame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frame);
    }
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };

  return {
    cancel() {
      clear();
      pending = [];
    },
    schedule(run: () => void) {
      if (frame !== null || timer !== null) return;
      const fire = () => {
        clear();
        run();
      };
      // A frame *and* a timer, whichever comes first.
      //
      // The first version trusted `requestAnimationFrame` alone, with a
      // microtask fallback for where the function does not exist. That was the
      // wrong test: in the browser pane this was verified in, `rAF` exists,
      // `document.hidden` is false, `visibilityState` is "visible" — and the
      // callback never fires. The transcript stayed empty for as long as it was
      // watched.
      //
      // The same shape as `find_shell` on Windows, which is in the working
      // notes already: a shell that exists is not a shell that runs. Present
      // and working are two different questions, and only the second one
      // matters.
      //
      // 32ms is two frames: it never meaningfully beats a healthy rAF, and it
      // guarantees the buffer drains where rAF is throttled, offscreen, or —
      // as here — simply not delivered.
      if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(fire);
      }
      timer = setTimeout(fire, 32) as unknown as number;
    },
  };
})();

export const useEventStore = create<EventState>((set, get) => ({
  missionId: null,
  connection: "idle",
  events: [],
  malformed: [],
  streaming: {},
  endReason: null,
  endLimit: null,
  replaying: false,

  attach: (missionId) => {
    flushPending.cancel();
    get().reset();
    set({ missionId, replaying: false });
    socket ??= new EventSocket({
      onDecoded: (decoded) => get().ingest(decoded),
      onState: (connection) => set({ connection }),
    });
    socket.connect(missionId, 0);
  },

  /**
   * Show a finished mission by reading its events back off the log (§12 M6).
   *
   * Deliberately the *same* pipeline as live: every row goes through
   * `decodeFrame` and `ingest`, so the timeline and the scene derive a replay
   * exactly as they derive a running mission. A separate "replay renderer"
   * would be a second interpretation of the same events, and the two would
   * drift (§2.1).
   */
  replay: async (missionId) => {
    socket?.disconnect();
    flushPending.cancel();
    get().reset();
    set({ missionId, replaying: true, connection: "closed" });
    const { events } = await api.missionEvents(missionId);
    // Applied directly rather than through the buffer. A replay is a finite
    // list already in hand, so there is nothing to wait for and nothing to
    // coalesce — and deferring it made the transcript sit empty until a frame
    // came round, which on a client where rAF is not delivered is never.
    // React batches these anyway: they are all in one task.
    for (const raw of events) get().apply(decodeFrame(raw));
  },

  detach: () => {
    socket?.disconnect();
    flushPending.cancel();
    set({ connection: "closed" });
  },

  reset: () =>
    set({ events: [], malformed: [], streaming: {}, endReason: null, endLimit: null }),

  /**
   * One frame in, applied with the others that arrived alongside it.
   *
   * Attaching subscribes from seq 0, so opening a run that has been going for
   * a while delivers its whole history — 729 frames on one real run — as 729
   * separate socket messages. Applied one at a time that is 729 renders, each
   * copying an array that is growing, and the transcript visibly types itself
   * in: the run looked like it was being replayed rather than opened.
   *
   * React batches updates inside one task; these arrive in a task each. So the
   * batching has to be ours: frames are buffered and applied together on the
   * next frame. Live tokens still land within ~16ms, which is a frame, and a
   * frame is the fastest anything on screen can change anyway.
   */
  ingest: (decoded) => {
    pending.push(decoded);
    flushPending.schedule(() => get().applyPending());
  },

  applyPending: () => {
    const batch = pending;
    if (batch.length === 0) return;
    pending = [];
    for (const decoded of batch) get().apply(decoded);
  },

  apply: (decoded) => {
    if (decoded.kind === "malformed") {
      set((s) => ({
        malformed: [...s.malformed, { ...decoded, at: Date.now() }],
      }));
      return;
    }

    if (decoded.kind === "ephemeral") {
      const { messageId, text, agentId } = decoded.frame;
      set((s) => ({
        streaming: {
          ...s.streaming,
          [messageId]: {
            agentId: agentId ?? s.streaming[messageId]?.agentId ?? "",
            text: (s.streaming[messageId]?.text ?? "") + text,
          },
        },
      }));
      return;
    }

    const { event, known, futureVersion } = decoded;
    set((s) => {
      const next: Partial<EventState> = {
        events: [...s.events, { event, known, futureVersion }],
      };

      if (event.draft.type === "agent.message") {
        // The stored message is authoritative; the accumulated deltas were only
        // ever a preview of it, so they are dropped rather than merged (§7.1).
        const { [(event.draft.payload as any).messageId]: _done, ...rest } = s.streaming;
        next.streaming = rest;
      } else if (event.draft.type === "mission.ended") {
        next.endReason = (event.draft.payload as any).reason ?? "unknown";
        next.endLimit = (event.draft.payload as any).limit ?? null;
      } else if (s.endReason !== null) {
        // A mission can be continued, so `mission.ended` is the end of a
        // *round*, not the end of the log. Anything arriving after one means a
        // new round has started — and without this the composer went on
        // showing "Send" over a team that was already thinking, because the
        // previous round's ending was still the latest one on record.
        next.endReason = null;
        next.endLimit = null;
      }
      return next;
    });

    // A question and its answer are events like any other, so the waiting list
    // is derived here rather than polled. Replayed history is skipped: those
    // questions were answered long ago, and re-raising them would put a dead
    // run's modal in front of a user who is only reading (§12 M6).
    if (!get().replaying) {
      useApprovalStore.getState().observe(event, get().missionId);
    }
  },
}));

/** Chat bubbles, derived from the same events the timeline shows. */
export interface ChatTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  streaming: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/**
 * A plain function over the two store slices, NOT a zustand selector.
 *
 * Used as a selector it would return a freshly built array on every call, so
 * the store would see a new snapshot each render and loop forever. Callers
 * subscribe to `events` and `streaming` — both stable references — and memoise
 * this on top.
 */
export function buildTurns(
  events: SequencedEntry[],
  streaming: Record<string, StreamingMessage>,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const { event } of events) {
    const p = event.draft.payload as any;
    if (event.draft.type === "user.message") {
      turns.push({ id: event.id, role: "user", text: p.content ?? "", streaming: false });
    } else if (event.draft.type === "agent.message") {
      turns.push({
        id: event.id,
        role: "agent",
        text: p.content ?? "",
        streaming: false,
        usage: p.usage,
      });
    }
  }
  for (const [messageId, partial] of Object.entries(streaming)) {
    turns.push({
      id: `stream-${messageId}`,
      role: "agent",
      text: partial.text,
      streaming: true,
    });
  }
  return turns;
}
