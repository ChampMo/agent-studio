/**
 * What to say about a search endpoint's allowance (§16.5).
 *
 * Pure, because every interesting case here is a shape of data rather than a
 * shape of pixels, and each one was observed on a real endpoint rather than
 * imagined:
 *
 * * **Brave reports several windows at once**, a per-second cap beside a
 *   per-month one. Only one of those is worth a bar: a second refills before
 *   you can read it, so a bar for it would swing between full and empty for
 *   reasons that mean nothing.
 * * **A window can be declared with a limit of zero.** Seen on a real postpaid
 *   key, whose monthly window reads `0;w=2592000` — that plan's ceiling is a
 *   spend limit in dollars, which no API returns. Drawing 0 of 0 would say the
 *   account is exhausted, which is the opposite of what is true.
 * * **Tavily states a total with no period at all.** `/usage` returns
 *   `{usage, limit}` and never says over what. Its dashboard calls it a monthly
 *   plan; the dashboard is not the API, so the period is left unsaid rather
 *   than copied across (§3.1).
 * * **The two count different things.** Brave meters requests, Tavily meters
 *   credits — a search is one credit and a crawl is not — so the unit travels
 *   with the numbers instead of being assumed.
 *
 * And the number is a reading, not a gauge. It is taken when the key is tested,
 * which is why nothing here renders without the caller putting the moment
 * beside it.
 *
 * Hence four outcomes rather than three: **not measured** is separate from
 * **measured, and it reports none**. Collapsing them put "this endpoint reports
 * no allowance" under a key that had simply never been asked — our own gap on
 * screen as a fact about the world, which is the mistake the capability probe's
 * `inconclusive` exists to prevent (§3.1).
 */
import type { QuotaWindow } from "../../transport/rest";

/** Below this, a window is a rate limit rather than an allowance. A cap that
 *  refills every second is not something a person spends down. */
const RATE_BELOW_SEC = 60;

export type QuotaView =
  /** A real allowance: draw the bar. `per` is empty when the endpoint stated a
   *  total without a period, and the sentence then simply omits one. */
  | {
      kind: "meter";
      limit: number;
      remaining: number;
      used: number;
      per: string;
      unit: string;
    }
  /** Only a rate was reported. True, worth saying, not a bar. */
  | { kind: "rate"; limit: number; per: string; unit: string }
  /** Asked, and this endpoint reports nothing usable. */
  | { kind: "silent" }
  /** Never asked. Not the same claim, and not ours to make. */
  | { kind: "unmeasured" };

/** "a month", "a day", "12 seconds" — the unit the number is in. */
export function periodName(seconds: number): string {
  const known: Record<number, string> = {
    1: "a second",
    60: "a minute",
    3600: "an hour",
    86400: "a day",
    604800: "a week",
    2592000: "a month",
  };
  if (known[seconds]) return known[seconds]!;
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function readQuota(windows: QuotaWindow[] | null | undefined): QuotaView {
  // Null and undefined are "nobody has asked this endpoint yet"; an empty list
  // is "asked, and it answered with nothing".
  if (windows == null) return { kind: "unmeasured" };

  const real = windows.filter((w) => w.limit > 0);
  if (real.length === 0) return { kind: "silent" };

  // A window with no period is an allowance — a total you spend down — so it
  // belongs with the ones long enough to budget against, not with the rates.
  const allowances = real.filter(
    (w) => w.windowSec === null || w.windowSec >= RATE_BELOW_SEC,
  );
  if (allowances.length > 0) {
    const w = allowances.reduce((a, b) =>
      (b.windowSec ?? 0) > (a.windowSec ?? 0) ? b : a,
    );
    // Clamped, because `remaining` is the endpoint's number and this is ours:
    // a negative "used" from a value we did not compute would be our arithmetic
    // showing through rather than anything it said.
    const remaining = Math.max(0, Math.min(w.limit, w.remaining));
    return {
      kind: "meter",
      limit: w.limit,
      remaining,
      used: w.limit - remaining,
      per: w.windowSec === null ? "" : periodName(w.windowSec),
      unit: w.unit,
    };
  }

  const fastest = real.reduce((a, b) =>
    (b.windowSec ?? 0) < (a.windowSec ?? 0) ? b : a,
  );
  return {
    kind: "rate",
    limit: fastest.limit,
    per: periodName(fastest.windowSec ?? 1),
    unit: fastest.unit,
  };
}
