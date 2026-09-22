/**
 * The box a floating panel actually has to stay inside.
 *
 * **The nearest ancestor that clips, not the window.** That distinction has
 * now cost this project twice, in the same shape both times: a panel sits
 * comfortably inside the viewport, a check against `window` finds nothing
 * wrong, and something three levels up is doing the cutting. First `main`
 * with `overflow-hidden`, taking half a menu off the side. Then `.ai-panel` —
 * whose `overflow: clip` exists to keep a rotating gradient inside its own
 * border radius — cutting 61px off the bottom of a provider dropdown that the
 * viewport had 323px of room for.
 *
 * Both axes, because both had the bug and only one had been fixed. `Menu`
 * gained a horizontal version after the first; its vertical flip went on
 * measuring against `window.innerHeight`, and `Select` measured against the
 * window in both directions. Three readers of one question is how they end up
 * with three answers (§2.1).
 *
 * One walk covers both: CSS resolves a computed `visible` to `auto` when the
 * other axis is not visible, so an element that clips one way clips both.
 */
export interface ClipRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function clipRect(node: HTMLElement): ClipRect {
  let parent = node.parentElement;
  while (parent && parent !== document.body) {
    const style = getComputedStyle(parent);
    if (
      style.overflow !== "visible" ||
      style.overflowX !== "visible" ||
      style.overflowY !== "visible"
    ) {
      const box = parent.getBoundingClientRect();
      return {
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
      };
    }
    parent = parent.parentElement;
  }
  return {
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    left: 0,
  };
}

/**
 * Which way a panel should open.
 *
 * Pulled out of the two components that were each deciding it, and each
 * deciding it slightly differently: `Menu` required up to fit *better* than
 * down, `Select` only required the anchor's top to be further from the edge
 * than the space below it. Same question, two answers, and both were
 * measuring against the wrong box anyway.
 *
 * The rule is deliberately reluctant. It flips only when down genuinely does
 * not fit **and** up fits better, so a panel taller than the space available
 * either way still opens the direction people expect rather than picking the
 * marginally less bad one and looking like a glitch.
 */
export function shouldDropUp({
  anchorTop,
  anchorBottom,
  panelHeight,
  bounds,
  gap = 8,
}: {
  anchorTop: number;
  anchorBottom: number;
  panelHeight: number;
  bounds: ClipRect;
  gap?: number;
}): boolean {
  const below = bounds.bottom - anchorBottom;
  const above = anchorTop - bounds.top;
  return below < panelHeight + gap && above > below;
}
