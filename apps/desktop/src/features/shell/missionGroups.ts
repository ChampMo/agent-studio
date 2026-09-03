/**
 * Turning a flat mission list into day groups (§18.2).
 *
 * Kept separate from the component and free of React so the awkward parts —
 * midnight, "yesterday", a run started before midnight and still going — are
 * testable rather than eyeballed. `now` is passed in for the same reason: a
 * function that reads the clock itself can only be tested at the moment the
 * test happens to run.
 *
 * Grouping is by *local* calendar day, because that is the day the person
 * remembers working. The timestamps on the wire are UTC (§9.2); `Date` converts
 * them, and the group a run falls into follows the viewer's clock.
 */

import { formatDay } from "../../lib/format";

export interface DayGroup<T> {
  /** Stable across renders: the local calendar date, `YYYY-MM-DD`. */
  key: string;
  label: string;
  items: T[];
}

export interface DayLabels {
  today: string;
  yesterday: string;
}

/** The local calendar day, as a sortable key. Not `toISOString` — that is UTC,
 *  and a run at 8pm on the 3rd would land on the 4th. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function groupByDay<T extends { startedAt: string }>(
  items: T[],
  labels: DayLabels,
  now: Date = new Date(),
): DayGroup<T>[] {
  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate);

  const groups = new Map<string, DayGroup<T>>();

  for (const item of items) {
    const when = new Date(item.startedAt);
    // A row whose timestamp will not parse still happened; it goes in a group
    // of its own rather than vanishing from the list (§8).
    const key = Number.isNaN(when.getTime()) ? "unknown" : dayKey(when);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label:
          key === today
            ? labels.today
            : key === yesterday
              ? labels.yesterday
              : key === "unknown"
                ? "—"
                : formatDay(when, now),
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  }

  // Newest day first. `unknown` sorts to the end: it is not a date, so it
  // cannot claim a position among them.
  return [...groups.values()].sort((a, b) => {
    if (a.key === "unknown") return 1;
    if (b.key === "unknown") return -1;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });
}

/** Substring match on the goal, case-insensitive. Deliberately not a fuzzy
 *  match: a search that returns things which do not contain what was typed
 *  makes an empty result impossible to trust. */
export function matchesQuery(goal: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return goal.toLowerCase().includes(q);
}
