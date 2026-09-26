/**
 * A socket that has been superseded must stop being one of our sockets.
 *
 * Found on a real run, from the screen rather than from a test: the
 * transcript printed
 *
 *   **Del**Del**Deliveriveriverable:** `TEST_Pable:** `TEST_Pable:** ...
 *
 * over an event log that was perfectly clean. Every fragment appeared exactly
 * three times and the text measured 2.84x its true length — three copies of
 * one delta stream interleaved into one buffer, not a parser going wrong.
 *
 * The stored events were fine because `onmessage` dedupes *sequenced* frames
 * on their id. Ephemeral deltas have no id and are deduped by nothing, so the
 * one channel with no protection was the one that showed the fault.
 *
 * Two faults, and they compound. `close()` is asynchronous, so a socket told
 * to go on delivering until the handshake finishes — and its `onmessage` had
 * no idea it had been replaced. Worse, its `onclose` then ran the *live*
 * socket's bookkeeping: it nulled `this.ws`, which by then pointed at the
 * replacement, and read a `closedByUs` that `connect()` had already reset to
 * false — so it concluded the connection had dropped and opened another one.
 *
 * One `attach` too many therefore left three sockets alive, which is exactly
 * the multiple the screen showed. `attach` is called from six places.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./handshake", () => ({
  requireHandshake: () => ({ wsBase: "ws://127.0.0.1:1", token: "t" }),
}));

const { EventSocket } = await import("./ws");

/** Every socket built, so a test can drive the superseded ones too. */
const built: FakeSocket[] = [];

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor() {
    built.push(this);
  }

  /** Real `close()` only *begins* the handshake. Messages keep arriving. */
  close() {
    this.closed = true;
  }

  /** The server sends a token of a streaming reply. */
  delta(messageId: string, text: string) {
    this.onmessage?.({
      data: JSON.stringify({ channel: "ephemeral", messageId, text, agentId: "a1" }),
    });
  }

  /** The close handshake finally completing, some time after `close()`. */
  finishClosing(code = 1006) {
    this.onclose?.({ code });
  }
}

function socketUnderTest() {
  built.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
  const text: string[] = [];
  const s = new EventSocket({
    onDecoded: (d) => {
      if (d.kind === "ephemeral") text.push(d.frame.text);
    },
    onState: () => {},
  });
  return { s, text };
}

describe("a socket that has been replaced", () => {
  it("delivers nothing more, though it is still open", () => {
    const { s, text } = socketUnderTest();
    s.connect("m-1", 0);
    const first = built[0]!;

    // Opening the run again — the app does this from six places.
    s.connect("m-1", 0);
    const second = built[built.length - 1]!;

    // The first socket has been told to close and has not finished doing so.
    expect(first.closed).toBe(true);
    first.delta("msg-1", "**Del");
    second.delta("msg-1", "**Del");

    expect(text).toEqual(["**Del"]);
  });

  it("does not reopen a third one when it finally closes", () => {
    const { s } = socketUnderTest();
    s.connect("m-1", 0);
    const first = built[0]!;
    s.connect("m-1", 0);

    expect(built.length).toBe(2);

    // The superseded socket's close arrives *after* connect() has already
    // reset `closedByUs`. Read by the live socket's rules it looks like a
    // dropped connection, and the old code answered it by reconnecting.
    vi.useFakeTimers();
    try {
      first.finishClosing();
      vi.advanceTimersByTime(10_000);
      expect(built.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not null out the live socket on its way out", () => {
    const { s, text } = socketUnderTest();
    s.connect("m-1", 0);
    const first = built[0]!;
    s.connect("m-1", 0);
    const live = built[1]!;

    first.finishClosing();

    // If the departing socket cleared `this.ws`, the live one is orphaned:
    // still delivering, but no longer the socket the client thinks it has.
    live.delta("msg-1", "still here");
    expect(text).toEqual(["still here"]);
  });
});

describe("the ordinary paths still work", () => {
  it("reconnects when the live socket really does drop", () => {
    const { s } = socketUnderTest();
    s.connect("m-1", 0);
    vi.useFakeTimers();
    try {
      built[0]!.finishClosing(1006);
      vi.advanceTimersByTime(10_000);
      expect(built.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays shut when we are the ones who closed it", () => {
    const { s } = socketUnderTest();
    s.connect("m-1", 0);
    s.disconnect();
    vi.useFakeTimers();
    try {
      built[0]!.finishClosing(1006);
      vi.advanceTimersByTime(10_000);
      expect(built.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
