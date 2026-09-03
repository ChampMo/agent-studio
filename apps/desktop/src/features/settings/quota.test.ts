/**
 * The rules for drawing an allowance, and the shapes real endpoints sent.
 *
 * Every fixture below is a response this app actually received, not a guess at
 * one. That matters most for the two that look like bugs and are not: a window
 * declared with a limit of zero, and a total with no period at all.
 */
import { describe, expect, it } from "vitest";
import { periodName, readQuota } from "./quota";
import type { QuotaWindow } from "../../transport/rest";

/** Brave's shape: requests, over a stated window. */
const brave = (
  ...windows: [limit: number, remaining: number, windowSec: number][]
): QuotaWindow[] =>
  windows.map(([limit, remaining, windowSec]) => ({
    limit,
    remaining,
    windowSec,
    resetSec: null,
    unit: "requests",
  }));

/** Tavily's shape: credits, and no period stated anywhere. */
const tavily = (limit: number, remaining: number): QuotaWindow[] => [
  { limit, remaining, windowSec: null, resetSec: null, unit: "credits" },
];

describe("what an endpoint's allowance means", () => {
  it("draws the month, not the second, when Brave reports both", () => {
    // A free key: `1;w=1, 2000;w=2592000`. The per-second cap is real and is
    // not what anyone is budgeting against.
    const view = readQuota(brave([1, 1, 1], [2000, 1987, 2592000]));
    expect(view).toEqual({
      kind: "meter",
      limit: 2000,
      remaining: 1987,
      used: 13,
      per: "a month",
      unit: "requests",
    });
  });

  it("refuses to draw a meter for a window the plan does not meter", () => {
    // Observed on a real postpaid key: `50;w=1, 0;w=2592000`. That plan's
    // ceiling is a spend limit in dollars, which no API returns. Rendering the
    // header as 0 of 0 would say the account is exhausted — the opposite.
    const view = readQuota(brave([50, 49, 1], [0, 0, 2592000]));
    expect(view).toEqual({
      kind: "rate",
      limit: 50,
      per: "a second",
      unit: "requests",
    });
  });

  it("draws a total that came with no period, and claims no period", () => {
    // Tavily's `/usage`: `{usage: 3, limit: 1500}` and nothing about a window.
    // It is still an allowance — you spend it down — so it gets a bar, and the
    // sentence simply does not end with "this month".
    const view = readQuota(tavily(1500, 1497));
    expect(view).toEqual({
      kind: "meter",
      limit: 1500,
      remaining: 1497,
      used: 3,
      per: "",
      unit: "credits",
    });
  });

  it("says nothing for an endpoint that says nothing", () => {
    // Asked and silent. Not zero — that distinction is the whole reason this
    // module exists.
    expect(readQuota([])).toEqual({ kind: "silent" });
    expect(readQuota(brave([0, 0, 2592000]))).toEqual({ kind: "silent" });
  });

  it("does not report silence from an endpoint nobody asked", () => {
    // The bug this caught in the app: every key added before the reading
    // existed showed "this endpoint reports no allowance" — a claim that had
    // never been checked. Our gap, printed as their fact.
    expect(readQuota(null)).toEqual({ kind: "unmeasured" });
    expect(readQuota(undefined)).toEqual({ kind: "unmeasured" });
  });

  it("never reports using more than the limit", () => {
    // `remaining` is the endpoint's number and `used` is ours. A window that
    // came back inconsistent must not produce arithmetic nobody can explain.
    expect(readQuota(brave([100, -5, 86400]))).toMatchObject({ used: 100, remaining: 0 });
    expect(readQuota(brave([100, 400, 86400]))).toMatchObject({ used: 0, remaining: 100 });
  });

  it("names a period it has never seen rather than dropping it", () => {
    expect(periodName(2592000)).toBe("a month");
    expect(periodName(86400)).toBe("a day");
    expect(periodName(172800)).toBe("2 days");
    expect(periodName(7200)).toBe("2 hours");
    expect(periodName(90)).toBe("90 seconds");
  });

  it("takes the longest metered window when several qualify", () => {
    const view = readQuota(brave([60, 60, 3600], [2000, 1000, 2592000]));
    expect(view).toMatchObject({ per: "a month", limit: 2000 });
  });

  it("prefers a stated allowance over a bare rate", () => {
    const view = readQuota([...brave([50, 49, 1]), ...tavily(1500, 1497)]);
    expect(view).toMatchObject({ kind: "meter", unit: "credits" });
  });
});
