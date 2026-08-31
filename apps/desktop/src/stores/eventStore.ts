/**
 * The single consumer of the event stream (PROJECT_BRIEF.md §2.1).
 *
 * Both readers of an event go through here: the timeline today, and
 * `scene/bindings` in M5. Neither component subscribes to the socket itself —
 * that is what keeps the two views showing the same run rather than two
 * slightly different interpretations of it.
 */
import { create } from "zustand";
import type { Decoded } from "../transport/decode";
import type { EventEnvelope } from "../transport/events.generated";
import { EventSocket, type ConnectionState } from "../transport/ws";

export interface SequencedEntry {
  event: EventEnvelope;
  known: boolean;
  futureVersion: boolean;
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
  /** Partial text per messageId, assembled from deltas while a reply streams. */
  streaming: Record<string, string>;
  endReason: string | null;

  attach: (missionId: string) => void;
  detach: () => void;
  reset: () => void;
  ingest: (decoded: Decoded) => void;
}

let socket: EventSocket | null = null;

export const useEventStore = create<EventState>((set, get) => ({
  missionId: null,
  connection: "idle",
  events: [],
  malformed: [],
  streaming: {},
  endReason: null,

  attach: (missionId) => {
    get().reset();
    set({ missionId });
    socket ??= new EventSocket({
      onDecoded: (decoded) => get().ingest(decoded),
      onState: (connection) => set({ connection }),
    });
    socket.connect(missionId, 0);
  },

  detach: () => {
    socket?.disconnect();
    set({ connection: "closed" });
  },

  reset: () =>
    set({ events: [], malformed: [], streaming: {}, endReason: null }),

  ingest: (decoded) => {
    if (decoded.kind === "malformed") {
      set((s) => ({
        malformed: [...s.malformed, { ...decoded, at: Date.now() }],
      }));
      return;
    }

    if (decoded.kind === "ephemeral") {
      const { messageId, text } = decoded.frame;
      set((s) => ({
        streaming: { ...s.streaming, [messageId]: (s.streaming[messageId] ?? "") + text },
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
      }
      return next;
    });
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
  streaming: Record<string, string>,
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
  for (const [messageId, text] of Object.entries(streaming)) {
    turns.push({ id: `stream-${messageId}`, role: "agent", text, streaming: true });
  }
  return turns;
}
