/**
 * The dot means one thing: this finished while you were looking elsewhere.
 *
 * Keyed on the ending, not the id — a mission can be continued, so a run you
 * read yesterday that ended again this morning is unread again.
 */
import { describe, expect, it } from "vitest";

import { isUnread } from "./seenStore";

const ended = (endedAt: string | null, endReason: string | null = "completed") => ({
  id: "m1",
  endedAt,
  endReason,
});

describe("what counts as unread", () => {
  it("marks a finished run nobody has opened", () => {
    expect(isUnread({}, ended("2026-09-03T10:00:00Z"))).toBe(true);
  });

  it("clears once it has been opened", () => {
    const seen = { m1: "2026-09-03T10:00:00Z" };
    expect(isUnread(seen, ended("2026-09-03T10:00:00Z"))).toBe(false);
  });

  it("comes back when a continued run ends again", () => {
    // The whole reason the mark is the ending rather than the id.
    const seen = { m1: "2026-09-03T10:00:00Z" };
    expect(isUnread(seen, ended("2026-09-03T14:00:00Z"))).toBe(true);
  });

  it("never marks a run that is still going", () => {
    // It has not finished, so there is nothing to have missed — and marking it
    // now would hide the ending when it arrives.
    expect(isUnread({}, ended(null, null))).toBe(false);
  });

  it("shows a dot rather than nothing when storage is unavailable", () => {
    // A private window or a browser refusing site data returns {}. The failure
    // is a dot too many, never a run you were never told about.
    expect(isUnread({}, ended("2026-09-03T10:00:00Z"))).toBe(true);
  });
});
