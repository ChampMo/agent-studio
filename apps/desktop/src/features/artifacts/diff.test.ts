/**
 * The property the display depends on: every line of both inputs appears
 * exactly once. A diff that summarised lines away would be the same failure as
 * a timeline that drops events.
 */
import { describe, expect, it } from "vitest";

import { CONTEXT, MAX_LINES, diffLines, hunks, toLines } from "./diff";

const text = (...lines: string[]) => lines.join("\n") + "\n";

describe("splitting into lines", () => {
  it("does not invent an empty last line from the trailing newline", () => {
    // No editor shows one, so neither does this.
    expect(toLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toLines("a\nb")).toEqual(["a", "b"]);
    expect(toLines("")).toEqual([]);
  });

  it("keeps a genuine blank line", () => {
    expect(toLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});

describe("what changed", () => {
  it("marks an inserted line and leaves the rest alone", () => {
    const d = diffLines(text("a", "c"), text("a", "b", "c"));
    expect(d.map((l) => [l.kind, l.text])).toEqual([
      ["same", "a"],
      ["added", "b"],
      ["same", "c"],
    ]);
  });

  it("marks a removed line", () => {
    const d = diffLines(text("a", "b", "c"), text("a", "c"));
    expect(d.filter((l) => l.kind === "removed").map((l) => l.text)).toEqual(["b"]);
  });

  it("shows a changed line as one removal and one addition", () => {
    // Which is what it is. Claiming to know a line was "edited" rather than
    // replaced would be a guess about intent.
    const d = diffLines(text("a", "old", "c"), text("a", "new", "c"));
    expect(d.map((l) => l.kind)).toEqual(["same", "removed", "added", "same"]);
  });

  it("numbers the lines on both sides", () => {
    const d = diffLines(text("a", "b"), text("a", "x", "b"));
    expect(d.map((l) => [l.before, l.after])).toEqual([
      [1, 1],
      [null, 2],
      [2, 3],
    ]);
  });

  it("loses nothing", () => {
    const before = text("one", "two", "three", "four");
    const after = text("one", "TWO", "three", "five", "six");
    const d = diffLines(before, after);
    expect(d.filter((l) => l.kind !== "added").map((l) => l.text)).toEqual(
      toLines(before),
    );
    expect(d.filter((l) => l.kind !== "removed").map((l) => l.text)).toEqual(
      toLines(after),
    );
  });

  it("handles a file being created and a file being emptied", () => {
    expect(diffLines("", text("a")).map((l) => l.kind)).toEqual(["added"]);
    expect(diffLines(text("a"), "").map((l) => l.kind)).toEqual(["removed"]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("says a huge file changed rather than pretending to know where", () => {
    const big = text(...Array.from({ length: MAX_LINES + 1 }, (_, i) => `l${i}`));
    const d = diffLines(big, big + "extra\n");
    expect(d.every((l) => l.kind !== "same")).toBe(true);
  });
});

describe("only the parts worth showing", () => {
  it("keeps a little of what surrounds a change", () => {
    const lines = diffLines(
      text(...Array.from({ length: 20 }, (_, i) => `l${i}`)),
      text(...Array.from({ length: 20 }, (_, i) => (i === 10 ? "changed" : `l${i}`))),
    );
    const [hunk, ...rest] = hunks(lines);
    expect(rest).toHaveLength(0);
    // Three either side of the removal and the addition.
    expect(hunk!.lines).toHaveLength(CONTEXT * 2 + 2);
  });

  it("counts what it skipped rather than swallowing it", () => {
    // A reader has to be able to see that something was left out — the same
    // rule the activity fold follows.
    const lines = diffLines(
      text(...Array.from({ length: 30 }, (_, i) => `l${i}`)),
      text(...Array.from({ length: 30 }, (_, i) => (i === 25 ? "changed" : `l${i}`))),
    );
    const [hunk] = hunks(lines);
    expect(hunk!.skipped).toBeGreaterThan(0);
  });

  it("returns nothing at all when nothing changed", () => {
    const same = text("a", "b", "c");
    expect(hunks(diffLines(same, same))).toEqual([]);
  });

  it("splits changes that are far apart into separate hunks", () => {
    const before = text(...Array.from({ length: 40 }, (_, i) => `l${i}`));
    const after = text(
      ...Array.from({ length: 40 }, (_, i) => (i === 2 || i === 35 ? `${i}!` : `l${i}`)),
    );
    expect(hunks(diffLines(before, after))).toHaveLength(2);
  });
});
