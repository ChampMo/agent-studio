/**
 * The three places an updater can quietly say something untrue.
 *
 * **A download with no declared length is not a download of zero bytes.** The
 * `Started` event carries `contentLength` only when the server sent one, and
 * `contentLength ?? 0` would give the panel a denominator — so it would draw a
 * bar, pinned at 0% or at some fraction of a number nobody measured. It is the
 * same rule as `costUsd` being null rather than $0 and `quota` being null
 * rather than empty: our own missing data must never be written down as a fact
 * about the world (§1.1).
 *
 * **"Not asked" is not "nothing to offer".** A failed check must not leave the
 * store looking like a successful one that found nothing, or the panel says
 * there is no update when what happened is that GitHub could not be reached.
 *
 * **A browser has nothing to update.** The plugin is not there, so the store
 * has to say so rather than throwing on a dynamic import at startup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.fn();
const inTauri = vi.fn(() => true);

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
vi.mock("../lib/popout", () => ({ inTauri: () => inTauri() }));

import { useUpdateStore } from "./updateStore";

/** A fake `Update`, driving the progress callback with whatever is passed. */
function offer(events: unknown[], version = "0.2.0") {
  return {
    version,
    currentVersion: "0.1.0",
    body: "notes",
    date: null,
    downloadAndInstall: async (cb: (e: unknown) => void) => {
      for (const event of events) cb(event);
    },
  };
}

const fresh = {
  stage: "unknown" as const,
  installed: null,
  offered: null,
  notes: null,
  published: null,
  received: 0,
  total: null,
  error: null,
  checkedAt: null,
};

beforeEach(() => {
  useUpdateStore.setState(fresh);
  check.mockReset();
  inTauri.mockReturnValue(true);
});

describe("a download the server did not measure", () => {
  it("counts the bytes and refuses to invent a total", async () => {
    check.mockResolvedValue(
      offer([
        // No `contentLength`: the server sent none.
        { event: "Started", data: {} },
        { event: "Progress", data: { chunkLength: 1000 } },
        { event: "Progress", data: { chunkLength: 2400 } },
        { event: "Finished" },
      ]),
    );
    await useUpdateStore.getState().check();
    await useUpdateStore.getState().install();

    const state = useUpdateStore.getState();
    expect(state.received).toBe(3400);
    // Null, not 0. A panel reading `total` decides between a bar and a
    // sentence on exactly this, and 0 would be a bar over a made-up number.
    expect(state.total).toBeNull();
    expect(state.stage).toBe("ready");
  });

  it("keeps the total when there is one", async () => {
    check.mockResolvedValue(
      offer([
        { event: "Started", data: { contentLength: 35_444_230 } },
        { event: "Progress", data: { chunkLength: 12_000 } },
      ]),
    );
    await useUpdateStore.getState().check();
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState().total).toBe(35_444_230);
    expect(useUpdateStore.getState().received).toBe(12_000);
  });
});

describe("a check that did not get an answer", () => {
  it("is failed with the endpoint's own words, not 'no update'", async () => {
    check.mockRejectedValue(new Error("Could not fetch a valid release JSON"));
    await useUpdateStore.getState().check();

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("failed");
    expect(state.error).toContain("valid release JSON");
    // The distinction that matters: nothing is being offered, and that is not
    // the same as having been told there is nothing.
    expect(state.offered).toBeNull();
    expect(state.stage).not.toBe("current");
  });

  it("still records when it asked, so a panel can say so", async () => {
    check.mockRejectedValue(new Error("offline"));
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().checkedAt).toBeTypeOf("number");
  });
});

describe("an answer of nothing", () => {
  it("is `current`, with the version it compared against", async () => {
    check.mockResolvedValue(null);
    await useUpdateStore.getState().check();

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("current");
    expect(state.installed).toBe("0.1.0");
    expect(state.offered).toBeNull();
  });
});

describe("a browser", () => {
  it("reports that there is nothing to update rather than throwing", async () => {
    inTauri.mockReturnValue(false);
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().stage).toBe("unsupported");
    // And it did not even ask.
    expect(check).not.toHaveBeenCalled();
  });

  it("does not try to restart something that is not an app", async () => {
    inTauri.mockReturnValue(false);
    await expect(useUpdateStore.getState().restart()).resolves.toBeUndefined();
  });
});

describe("installing without an offer", () => {
  it("does nothing rather than entering a download that cannot start", async () => {
    // `install` is only reachable from the panel when there is an update, but
    // the store is the thing that has to hold that line: a `downloading` stage
    // with nothing downloading would spin in the sidebar for ever.
    check.mockResolvedValue(null);
    await useUpdateStore.getState().check();
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState().stage).toBe("current");
  });
});
