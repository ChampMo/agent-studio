/**
 * Dates and times, in the language the rest of the app is written in.
 *
 * `toLocaleDateString()` with no locale follows the operating system, and on a
 * Thai-locale machine that means Thai month names *and* the Buddhist calendar —
 * a run from November 2025 renders as "4 พ.ย. 2568" in an interface that is
 * otherwise entirely English (§13). Found by a grouping test asserting the year
 * "2025" against a string that said 2568.
 *
 * So the locale is pinned. When this app is translated, this is the one place
 * that has to learn where the user's language comes from — and it will be a
 * choice, not whatever the OS happened to be set to.
 */
const LOCALE = "en";

/** A calendar day: "12 Aug", or "4 Nov 2025" once it is not this year. */
export function formatDay(date: Date, sameYearAs: Date): string {
  return date.toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === sameYearAs.getFullYear() ? undefined : "numeric",
  });
}

/** Clock time, to the second: the timeline is a record, and a record that
 *  rounds to the minute cannot show the order of things inside one. */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString(LOCALE);
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(LOCALE);
}

/**
 * Bytes as a person reads them. Never rounded up past a boundary: 999 bytes is
 * not "1 KB".
 *
 * Moved here from `StoragePanel`, which was its only reader until the updater
 * needed to say how much of a download had arrived. Two copies of this would
 * have been two answers to "how big is that" on one screen (§2.1).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
