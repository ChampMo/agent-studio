/**
 * Which way a floating panel opens, as arithmetic.
 *
 * This was two components each deciding it against `window`, and the window
 * is the wrong box: the provider dropdown inside `.ai-panel` had 323px of
 * viewport below it and 61px of its list cut off, because that panel sets
 * `overflow: clip` to keep a rotating gradient inside its own border radius.
 *
 * `clipRect` needs a DOM and is checked in the app; the decision it feeds does
 * not, so it is checked here — including the case that produced the bug.
 */
import { describe, expect, it } from "vitest";

import { shouldDropUp } from "./clipRect";

const VIEWPORT = { top: 0, right: 1300, bottom: 900, left: 0 };

describe("which way a panel opens", () => {
  it("opens downward when there is room", () => {
    expect(
      shouldDropUp({
        anchorTop: 100,
        anchorBottom: 134,
        panelHeight: 118,
        bounds: VIEWPORT,
      }),
    ).toBe(false);
  });

  it("flips up when the clipping ancestor cuts it off", () => {
    // The real numbers off the broken screen: the trigger sat at 421–455
    // inside `.ai-panel`, which ends at 516. A 118px list needs 126 and has
    // 61, while there are 166 above it.
    const aiPanel = { top: 289, right: 1000, bottom: 516, left: 400 };
    expect(
      shouldDropUp({
        anchorTop: 421,
        anchorBottom: 455,
        panelHeight: 118,
        bounds: aiPanel,
      }),
    ).toBe(true);

    // And the check that had been running instead found nothing wrong.
    expect(
      shouldDropUp({
        anchorTop: 421,
        anchorBottom: 455,
        panelHeight: 118,
        bounds: VIEWPORT,
      }),
    ).toBe(false);
  });

  it("stays put when neither direction fits", () => {
    // A panel taller than the whole box opens the predictable way rather than
    // picking the marginally less bad direction and looking like a glitch.
    const tight = { top: 0, right: 500, bottom: 200, left: 0 };
    expect(
      shouldDropUp({
        anchorTop: 90,
        anchorBottom: 110,
        panelHeight: 400,
        bounds: tight,
      }),
    ).toBe(false);
  });

  it("counts the gap, so a panel that only just fits stays down", () => {
    // Room above on purpose, or the reluctance rule decides it first and the
    // gap never gets a say — which is what the first draft of this test did.
    const bounds = { top: 0, right: 500, bottom: 360, left: 0 };
    const anchor = { anchorTop: 200, anchorBottom: 234 };

    // 126 below, and a 118px list needs 126 with the gap. Exactly fits.
    expect(shouldDropUp({ ...anchor, panelHeight: 118, bounds })).toBe(false);
    // One pixel taller and it does not.
    expect(shouldDropUp({ ...anchor, panelHeight: 119, bounds })).toBe(true);
  });
});
