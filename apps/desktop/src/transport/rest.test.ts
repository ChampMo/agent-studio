/**
 * What a request says when it never arrives.
 *
 * The browser's own words for a dead port are "Failed to fetch", which tell a
 * user nothing about the one thing that actually fixes it. This page is handed
 * its port and token at load time and the dev launcher takes a fresh port on
 * every start, so a tab left open across a restart calls an address nobody is
 * listening on — for the rest of its life.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./handshake", () => ({
  requireHandshake: () => ({ apiBase: "http://127.0.0.1:49265", token: "t" }),
}));

const { api, ApiError } = await import("./rest");

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("a backend that is not there", () => {
  it("says so, and says what to do about it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const failure = await api.health().catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    // Status 0: it never reached an HTTP conversation at all.
    expect(failure.status).toBe(0);
    expect(failure.message).toContain("127.0.0.1:49265");
    expect(failure.message).toContain("reload");
    // The original is kept, so a console still shows what the browser said.
    expect((failure as Error).cause).toBeInstanceOf(TypeError);
  });

  it("leaves a real HTTP error alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "no" }), { status: 401 })),
    );

    const failure = await api.health().catch((e) => e);
    // A 401 is a different problem with a different fix — a stale token, not a
    // missing backend — and must not be dressed up as one.
    expect(failure.status).toBe(401);
    expect(failure.message).toBe("no");
  });
});

describe("a backend that is coming back", () => {
  it("rides out a restart on a read", async () => {
    // The dev launcher restarts the backend when a .py file changes and it
    // returns on the same port a second later. One edit should not produce a
    // wall of errors for something that fixed itself.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ok: true, version: "0.1.0" }), { status: 200 });
      }),
    );

    const health = await api.health();
    expect(health.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry a write", async () => {
    // A write that failed at the network level may still have arrived: the
    // reply is what went missing, not necessarily the request. Launching two
    // missions because one response was lost is worse than an error.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(
      api.startChat({ provider_id: "p", content: "hello" }),
    ).rejects.toThrow(/not reachable/);
    expect(calls).toBe(1);
  });

  it("gives up with the same message when it really is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(api.health()).rejects.toThrow(/reload/);
  });
});
