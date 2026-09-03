import { describe, expect, it } from "vitest";
import { groupByDay, matchesQuery } from "./missionGroups";

const labels = { today: "Today", yesterday: "Yesterday" };

/** Local noon, so no timezone can push these across a day boundary. */
function at(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe("grouping missions by day", () => {
  const now = new Date(2026, 7, 31, 15, 0); // 31 Aug 2026, local

  it("names today and yesterday, and dates everything else", () => {
    const groups = groupByDay(
      [
        { startedAt: at(2026, 8, 31) },
        { startedAt: at(2026, 8, 30) },
        { startedAt: at(2026, 8, 12) },
      ],
      labels,
      now,
    );

    // "Aug 12", not "12 Aug": the locale is pinned to English (lib/format.ts),
    // so the order is English's rather than the machine's.
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Aug 12"]);
  });

  it("puts the newest day first whatever order it was given", () => {
    const groups = groupByDay(
      [
        { startedAt: at(2026, 8, 12) },
        { startedAt: at(2026, 8, 31) },
        { startedAt: at(2026, 8, 30) },
      ],
      labels,
      now,
    );

    expect(groups.map((g) => g.key)).toEqual(["2026-08-31", "2026-08-30", "2026-08-12"]);
  });

  it("keeps several runs from one day together, in the order given", () => {
    const groups = groupByDay(
      [
        { startedAt: at(2026, 8, 31, 14), goal: "b" },
        { startedAt: at(2026, 8, 31, 9), goal: "a" },
      ],
      labels,
      now,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((m) => m.goal)).toEqual(["b", "a"]);
  });

  it("groups by the local day, not the UTC one", () => {
    // 23:30 local on the 31st. In any timezone east or west of UTC this is a
    // different UTC date, and `toISOString().slice(0, 10)` would file it under
    // the wrong day.
    const groups = groupByDay([{ startedAt: at(2026, 8, 31, 23) }], labels, now);
    expect(groups[0]!.label).toBe("Today");
  });

  it("shows the year once a run is older than this one", () => {
    const groups = groupByDay([{ startedAt: at(2025, 11, 4) }], labels, now);
    expect(groups[0]!.label).toContain("2025");
  });

  it("keeps a run whose timestamp will not parse", () => {
    // §8: an unreadable field is not a reason to drop a row. The run happened.
    const groups = groupByDay(
      [{ startedAt: at(2026, 8, 31) }, { startedAt: "not a date" }],
      labels,
      now,
    );

    expect(groups).toHaveLength(2);
    expect(groups.at(-1)!.key).toBe("unknown");
  });

  it("returns nothing for nothing", () => {
    expect(groupByDay([], labels, now)).toEqual([]);
  });
});

describe("searching past runs", () => {
  it("matches any part of the goal, ignoring case", () => {
    expect(matchesQuery("Summarise the Python release notes", "PYTHON")).toBe(true);
    expect(matchesQuery("Summarise the Python release notes", "rust")).toBe(false);
  });

  it("matches everything when nothing was typed", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });
});
