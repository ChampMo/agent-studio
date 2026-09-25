/**
 * A run the database could not read is counted, not hidden.
 *
 * A corrupted file left one mission whose `started_at` was NUL bytes, and
 * `GET /missions` answered 500 — so the sidebar went completely empty over a
 * database holding five good runs. The backend now leaves that row out and
 * says how many it left out; this is the client holding up its half, because a
 * number nothing renders is a number nobody is told (§1).
 *
 * The absent case matters as much as the present one. A backend older than the
 * field sends no `unreadable` at all, and `undefined` reaching the sidebar
 * would render as nothing or as `NaN runs could not be read` — our own gap
 * written down as a fact about the world (§1.1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMissions = vi.fn();

vi.mock("../transport/rest", () => ({ api: { listMissions: () => listMissions() } }));

import { useHistoryStore } from "./historyStore";

beforeEach(() => {
  listMissions.mockReset();
  useHistoryStore.setState({ missions: [], unreadable: 0, error: null });
});

describe("history load", () => {
  it("keeps the count of rows the backend could not read", async () => {
    listMissions.mockResolvedValue({ missions: [{ id: "m1" }], unreadable: 2 });

    await useHistoryStore.getState().load();

    expect(useHistoryStore.getState().missions).toHaveLength(1);
    expect(useHistoryStore.getState().unreadable).toBe(2);
  });

  it("reads a missing count as none rather than as unknown", async () => {
    listMissions.mockResolvedValue({ missions: [] });

    await useHistoryStore.getState().load();

    // Not undefined: the sidebar compares it and prints it.
    expect(useHistoryStore.getState().unreadable).toBe(0);
  });

  it("does not leave a previous count standing over a fresh list", async () => {
    useHistoryStore.setState({ unreadable: 3 });
    listMissions.mockResolvedValue({ missions: [{ id: "m1" }], unreadable: 0 });

    await useHistoryStore.getState().load();

    expect(useHistoryStore.getState().unreadable).toBe(0);
  });
});
