/**
 * The single event socket (PROJECT_BRIEF.md §2.1, §7.2).
 *
 * Everything the UI knows arrives here. There is no second channel: REST starts
 * and stops missions and returns ids, never content.
 *
 * Reconnect is resume, not restart. The client tracks the highest `seq` it has
 * seen and asks for everything after it, then dedupes on `id` because the seam
 * may legitimately overlap by an event.
 */
import { decodeFrame, type Decoded } from "./decode";
import { requireHandshake } from "./handshake";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface SocketHandlers {
  onDecoded: (decoded: Decoded) => void;
  onState: (state: ConnectionState) => void;
}

/** 1013 "try again later": the server says we fell behind and should resume. */
const CLOSE_LAGGED = 1013;
/** 1008 "policy violation": a bad or missing token. Retrying will not help. */
const CLOSE_UNAUTHORISED = 1008;

const BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;

export class EventSocket {
  private ws: WebSocket | null = null;
  private missionId: string | null = null;
  private lastSeq = 0;
  private seen = new Set<string>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;

  constructor(private handlers: SocketHandlers) {}

  connect(missionId: string, sinceSeq = 0): void {
    this.disconnect();
    this.missionId = missionId;
    this.lastSeq = sinceSeq;
    this.seen.clear();
    this.closedByUs = false;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.handlers.onState("closed");
  }

  private open(): void {
    if (!this.missionId) return;
    const { wsBase, token } = requireHandshake();
    const url = `${wsBase}/ws?mission_id=${encodeURIComponent(this.missionId)}&since_seq=${this.lastSeq}`;

    this.handlers.onState(this.attempt === 0 ? "connecting" : "reconnecting");

    // The token rides in the subprotocol list, not the query string: browsers
    // cannot set headers on a WS handshake, and a query string would land in
    // access logs and history (§9.1).
    const ws = new WebSocket(url, ["agent-studio.v1", `token.${token}`]);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onState("open");
    };

    ws.onmessage = (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data as string);
      } catch {
        this.handlers.onDecoded({
          kind: "malformed",
          raw: ev.data,
          reason: "frame is not valid JSON",
        });
        return;
      }

      const decoded = decodeFrame(raw);
      if (decoded.kind === "sequenced") {
        // Dedupe on id: a resume can re-deliver the event at the seam (§7.2).
        if (this.seen.has(decoded.event.id)) return;
        this.seen.add(decoded.event.id);
        this.lastSeq = Math.max(this.lastSeq, decoded.event.seq);
      }
      this.handlers.onDecoded(decoded);
    };

    ws.onclose = (ev) => {
      this.ws = null;
      if (this.closedByUs) return;
      if (ev.code === CLOSE_UNAUTHORISED) {
        // A retry would fail identically. Surface it instead of looping.
        this.handlers.onState("closed");
        return;
      }
      // Lagging is the server asking us to resume immediately; everything else
      // backs off. Either way we come back with lastSeq, so no event is lost.
      this.scheduleReopen(ev.code === CLOSE_LAGGED ? 0 : undefined);
    };

    ws.onerror = () => {
      // onclose always follows; reconnect logic lives there only.
    };
  }

  private scheduleReopen(delayOverride?: number): void {
    const delay =
      delayOverride ?? BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.handlers.onState("reconnecting");
    this.timer = setTimeout(() => this.open(), delay);
  }
}
