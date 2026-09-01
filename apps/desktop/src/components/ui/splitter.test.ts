/**
 * M9 proof: the divider works without a mouse (§17.1, §12 M9 criterion 1).
 *
 * A divider you can only drag is a control that a keyboard user cannot touch
 * (WCAG 2.1.1), so "it also has key bindings" is the requirement, not a nicety.
 * Testing it here rather than through the DOM is what §13 asks for — the
 * behaviour is arithmetic, and arithmetic can be checked without a browser.
 */
import { describe, expect, it } from "vitest";

import {
  COLLAPSED_BELOW,
  PAGE_STEP,
  STEP,
  clamp,
  isCollapsed,
  nextHeight,
  readStoredHeight,
  snap,
  snapPoints,
} from "./splitter";

const BOUNDS = { min: 0, max: 600 };
const ctx = (height: number, restore = 280) => ({ ...BOUNDS, height, restore });

describe("the keyboard", () => {
  it("moves by a small step on the arrows", () => {
    expect(nextHeight("ArrowDown", ctx(200))).toBe(200 + STEP);
    expect(nextHeight("ArrowUp", ctx(200))).toBe(200 - STEP);
  });

  it("moves by a large step on PageUp and PageDown", () => {
    expect(nextHeight("PageDown", ctx(200))).toBe(200 + PAGE_STEP);
    expect(nextHeight("PageUp", ctx(200))).toBe(200 - PAGE_STEP);
  });

  it("goes to the ends on Home and End", () => {
    expect(nextHeight("Home", ctx(200))).toBe(BOUNDS.min);
    expect(nextHeight("End", ctx(200))).toBe(BOUNDS.max);
  });

  it("grows downward, the way the divider moves", () => {
    // Reversing this makes the keyboard fight the pointer: the handle would go
    // one way and the pane the other.
    expect(nextHeight("ArrowDown", ctx(200))!).toBeGreaterThan(200);
  });

  it("stops at the ends rather than running past them", () => {
    expect(nextHeight("ArrowUp", ctx(4))).toBe(BOUNDS.min);
    expect(nextHeight("PageDown", ctx(580))).toBe(BOUNDS.max);
  });

  it("toggles shut and back to where it was", () => {
    // Enter closes it...
    expect(nextHeight("Enter", ctx(320))).toBe(BOUNDS.min);
    // ...and from shut, returns to the remembered height rather than a guess.
    expect(nextHeight("Enter", ctx(0, 320))).toBe(320);
  });

  it("treats space like enter, because it is a button-shaped action", () => {
    expect(nextHeight(" ", ctx(320))).toBe(BOUNDS.min);
  });

  it("ignores keys that are not its own", () => {
    // Returning a number for every key would swallow Tab and trap focus on the
    // divider — the opposite of what the keyboard support is for.
    for (const key of ["Tab", "a", "Escape", "ArrowLeft", "F5"]) {
      expect(nextHeight(key, ctx(200))).toBeNull();
    }
  });
});

describe("snapping", () => {
  it("settles onto shut, half or full", () => {
    expect(snapPoints(BOUNDS)).toEqual([0, 300, 600]);
    expect(snap(8, BOUNDS)).toBe(0);
    expect(snap(292, BOUNDS)).toBe(300);
    expect(snap(590, BOUNDS)).toBe(600);
  });

  it("leaves a height that is not near a snap point alone", () => {
    // Snapping everything would make the divider impossible to place, which is
    // worse than not snapping at all.
    expect(snap(180, BOUNDS)).toBe(180);
  });

  it("never returns a height outside the bounds", () => {
    expect(snap(-50, BOUNDS)).toBe(0);
    expect(snap(9999, BOUNDS)).toBe(600);
  });
});

describe("collapsed", () => {
  it("is about being invisible, not about being small", () => {
    // The scene stops its ticker on this answer (§17.1), so the line has to be
    // where nothing useful is visible any more.
    expect(isCollapsed(0)).toBe(true);
    expect(isCollapsed(COLLAPSED_BELOW - 1)).toBe(true);
    expect(isCollapsed(COLLAPSED_BELOW)).toBe(false);
    expect(isCollapsed(400)).toBe(false);
  });
});

describe("clamping", () => {
  it("keeps a height inside its bounds", () => {
    expect(clamp(-10, BOUNDS)).toBe(0);
    expect(clamp(700, BOUNDS)).toBe(600);
    expect(clamp(300, BOUNDS)).toBe(300);
  });

  it("survives a container too small to have a range", () => {
    // The window can be shorter than the pane's minimum; the answer has to be
    // a number, not NaN.
    expect(clamp(100, { min: 0, max: 0 })).toBe(0);
  });
});

describe("the height it starts at", () => {
  it("uses the default when nothing was saved", () => {
    // `Number(null)` is 0, so the naive version read a missing key as "the
    // user collapsed this on purpose" and every first run opened shut.
    expect(readStoredHeight(null, 280)).toBe(280);
    expect(readStoredHeight("", 280)).toBe(280);
    expect(readStoredHeight("   ", 280)).toBe(280);
  });

  it("uses the default when what was saved is not a number", () => {
    expect(readStoredHeight("tall", 280)).toBe(280);
    expect(readStoredHeight("-40", 280)).toBe(280);
  });

  it("honours a real saved height, including a deliberate zero", () => {
    expect(readStoredHeight("420", 280)).toBe(420);
    // Collapsed on purpose is a choice worth keeping.
    expect(readStoredHeight("0", 280)).toBe(0);
  });
});
