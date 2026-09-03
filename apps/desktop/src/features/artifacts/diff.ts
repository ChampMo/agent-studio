/**
 * What changed between two versions of a file, line by line.
 *
 * Written here rather than pulled in: this app ships with no network at
 * runtime and a diff of two text files is a well-understood forty lines, so a
 * dependency would be a supply chain and an update treadmill in exchange for
 * something that can be read in one sitting and tested exactly.
 *
 * The algorithm is the standard longest-common-subsequence walk. Its property
 * — the one the display depends on — is that **every line of both inputs
 * appears exactly once in the output**: a line is kept, added or removed, and
 * nothing is summarised away. A diff that dropped lines would be the same
 * failure as a timeline that drops events.
 *
 * Line numbers are carried on each row because a diff without them is a
 * picture of a change rather than a way to find it in the file.
 */

export type DiffKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old file, or null for an added line. */
  before: number | null;
  /** 1-based line number in the new file, or null for a removed line. */
  after: number | null;
}

/** Lines the way a file has them: a trailing newline does not make an empty
 *  last line, because no editor shows one. */
export function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Beyond this many lines the quadratic table is the wrong shape for the job
 * and the viewer is not going to render it anyway. The whole file comes back
 * as one removal and one addition, which is honest — it says the file changed
 * and declines to say precisely where.
 */
export const MAX_LINES = 4000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = toLines(before);
  const b = toLines(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text, i) => ({ kind: "removed" as const, text, before: i + 1, after: null })),
      ...b.map((text, i) => ({ kind: "added" as const, text, before: null, after: i + 1 })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]!, before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i]!, before: i + 1, after: null });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j]!, before: null, after: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: "removed", text: a[i]!, before: i + 1, after: null });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: "added", text: b[j]!, before: null, after: j + 1 });
    j += 1;
  }
  return out;
}

export interface Hunk {
  lines: DiffLine[];
  /** How many unchanged lines were skipped to get here. Shown rather than
   *  silently swallowed, the same rule the activity fold follows: a reader has
   *  to be able to see that something was left out. */
  skipped: number;
}

/** How many unchanged lines to keep either side of a change. */
export const CONTEXT = 3;

/**
 * The changed parts, with a little of what surrounds them.
 *
 * A file of 200 lines with a two-line change is 198 lines of noise, and
 * scrolling past them to find the change is the thing the diff was supposed to
 * save. Skipped runs are counted, never merely dropped.
 */
export function hunks(lines: DiffLine[], context = CONTEXT): Hunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep[k] = true;
    }
  });

  const out: Hunk[] = [];
  let current: DiffLine[] = [];
  let skipped = 0;
  let pendingSkip = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (keep[index]) {
      if (current.length === 0) skipped = pendingSkip;
      pendingSkip = 0;
      current.push(lines[index]!);
      continue;
    }
    if (current.length > 0) {
      out.push({ lines: current, skipped });
      current = [];
    }
    pendingSkip += 1;
  }
  if (current.length > 0) out.push({ lines: current, skipped });
  return out;
}
