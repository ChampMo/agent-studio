/**
 * What the divider does, as arithmetic (§17.1).
 *
 * The rules live here rather than inside the component for the same reason the
 * scene's poses do: a rule in a pure function is a test, and a rule inside an
 * event handler is something you verify by dragging it and squinting. The
 * component below this file wires keys and pointers to these functions and
 * decides nothing.
 *
 * Brief §13 rules out component tests. It does not rule out testing the
 * behaviour — it rules out testing it through the DOM.
 */

/** Steps in pixels. Small enough to be precise, large enough to be quick. */
export const STEP = 16;
export const PAGE_STEP = 80;

/** Below this the pane counts as collapsed: nothing is visible, so nothing
 *  should be rendered into it (§17.1 — the ticker stops). */
export const COLLAPSED_BELOW = 24;

/** How near a snap point counts as "at" it when a drag ends. */
export const SNAP_WITHIN = 28;

export interface Bounds {
  min: number;
  max: number;
}

export function clamp(height: number, { min, max }: Bounds): number {
  return Math.max(min, Math.min(height, max));
}

export function isCollapsed(height: number): boolean {
  return height < COLLAPSED_BELOW;
}

/**
 * The three places a drag settles onto: shut, half, and as tall as it goes.
 *
 * Only applied when a drag ends. A keyboard step must land exactly where it
 * was aimed — snapping an arrow key would make the control unusable for the
 * people the keyboard support exists for.
 */
export function snapPoints({ min, max }: Bounds): number[] {
  return [min, Math.round((min + max) / 2), max];
}

export function snap(height: number, bounds: Bounds): number {
  const target = snapPoints(bounds).find(
    (point) => Math.abs(point - height) <= SNAP_WITHIN,
  );
  return clamp(target ?? height, bounds);
}

/**
 * The height to start at, given whatever was saved.
 *
 * `Number(null)` is `0`, so a missing key read as "the user collapsed this on
 * purpose" and the pane opened shut with nothing on screen explaining why.
 * Parsing is its own function because that is a rule, and a rule belongs where
 * it can be tested.
 */
export function readStoredHeight(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const saved = Number(raw);
  return Number.isFinite(saved) && saved >= 0 ? saved : fallback;
}


export interface KeyContext extends Bounds {
  height: number;
  /** Where Enter goes back to when the pane is currently shut. */
  restore: number;
}

/**
 * The height a key press asks for, or null when the key is not ours.
 *
 * Down grows the pane, because the divider moves down. Reversing that makes
 * the keyboard feel like it is fighting the pointer.
 */
export function nextHeight(key: string, ctx: KeyContext): number | null {
  const { height, min, max, restore } = ctx;
  switch (key) {
    case "ArrowDown":
      return clamp(height + STEP, ctx);
    case "ArrowUp":
      return clamp(height - STEP, ctx);
    case "PageDown":
      return clamp(height + PAGE_STEP, ctx);
    case "PageUp":
      return clamp(height - PAGE_STEP, ctx);
    case "Home":
      return min;
    case "End":
      return max;
    case "Enter":
    case " ":
      // Toggle: shut it, or put it back where it was before it was shut.
      return isCollapsed(height) ? clamp(restore, ctx) : min;
    default:
      return null;
  }
}
