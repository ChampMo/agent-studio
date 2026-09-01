/**
 * M9 proof: the scene stops when nobody can see it (§12 M9 criterion 2).
 *
 * Before the splitter the scene lived in a tab and stopped existing when you
 * looked away. Now it is mounted all the time, so a loop running behind a
 * collapsed pane or an unfocused window is work whose entire output is
 * invisible — on a laptop battery.
 */
import { describe, expect, it } from "vitest";

import { COLLAPSED_BELOW } from "../../components/ui/splitter";
import { shouldAnimate } from "./activity";

const awake = { heightPx: 300, windowFocused: true, documentVisible: true };

describe("when the scene animates", () => {
  it("does, when it is visible and in front", () => {
    expect(shouldAnimate(awake)).toBe(true);
  });

  it("does not, when the splitter has closed it", () => {
    expect(shouldAnimate({ ...awake, heightPx: 0 })).toBe(false);
    expect(shouldAnimate({ ...awake, heightPx: COLLAPSED_BELOW - 1 })).toBe(false);
    // And starts again the moment it is opened past that line.
    expect(shouldAnimate({ ...awake, heightPx: COLLAPSED_BELOW })).toBe(true);
  });

  it("does not, when another window is in front", () => {
    expect(shouldAnimate({ ...awake, windowFocused: false })).toBe(false);
  });

  it("does not, when the window is minimised or in a background tab", () => {
    expect(shouldAnimate({ ...awake, documentVisible: false })).toBe(false);
  });

  it("needs every reason at once, not just one", () => {
    // A collapsed pane in a focused window is still invisible; a tall pane in a
    // hidden window is still unseen.
    expect(shouldAnimate({ heightPx: 0, windowFocused: true, documentVisible: true })).toBe(false);
    expect(shouldAnimate({ heightPx: 600, windowFocused: false, documentVisible: true })).toBe(false);
  });
});
