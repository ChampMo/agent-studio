/**
 * The room's own colours, read from the stylesheet.
 *
 * Pixi takes numbers, the theme lives in CSS variables, and there is exactly
 * one honest way to keep them from drifting: ask the document. A second table
 * of hex values in TypeScript would be a second answer to "what colour is the
 * floor", and the one nobody was looking at would be the wrong one (§2.1) —
 * which is the mistake this codebase has already made with `activeId`,
 * `can_run` and `lookFor`.
 *
 * So these are *derived* tokens, declared in `index.css` beside the ones the
 * DOM uses and resolved here at draw time. Switching theme redraws the scene
 * because the values it reads have changed, not because anything told it to.
 */

function read(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw.startsWith("#")) return fallback;
  const hex = raw.slice(1);
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const value = Number.parseInt(full.slice(0, 6), 16);
  return Number.isNaN(value) ? fallback : value;
}

function alpha(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export interface RoomColours {
  floorA: number;
  floorB: number;
  deskTop: number;
  deskSide: number;
  screen: number;
  paper: number;
  metal: number;
  danger: number;
  ink: number;
  /** The scene's own text. Pixi `TextStyle` holds a number, so these have to
   *  come through the same door as the furniture — a label left on a literal
   *  is a label that keeps yesterday's theme. */
  label: number;
  caption: number;
  task: number;
  bubble: number;
  bubbleText: number;
  /** The desk lamp: a soft pool under whoever is actually working. */
  lamp: number;
  /** How strongly it lands. Per theme, because the same wash over a dark floor
   *  and a light one are not the same picture. */
  lampAlpha: number;
  /** Daylight from the top-right corner of the room. */
  window: number;
  windowAlpha: number;
  /** Cat fur. Read here rather than held in `palette.ts` so the scene and the
   *  stylesheet cannot disagree about what colour a ginger cat is (§2.1). */
  coatGinger: number;
  coatGrey: number;
  coatCream: number;
  coatTux: number;
}

/** Read fresh each time the scene draws: a theme change is a different answer
 *  from the same call, which is the point of asking rather than caching. */
export function roomColours(): RoomColours {
  return {
    floorA: read("--room-floor-a", 0x1d2833),
    floorB: read("--room-floor-b", 0x18222c),
    deskTop: read("--room-desk-top", 0x9a6a40),
    deskSide: read("--room-desk-side", 0x6a4728),
    screen: read("--color-accent", 0x4fc3d9),
    paper: read("--room-paper", 0xe6eaee),
    metal: read("--room-metal", 0x7e8b99),
    danger: read("--color-stop", 0xf0776a),
    ink: read("--room-ink", 0x141a22),
    label: read("--color-text", 0xe6eaee),
    caption: read("--color-faint", 0x8b96a4),
    task: read("--color-accent", 0x4fc3d9),
    // The bubble is a raised surface with ordinary text on it, so it uses the
    // same pair the DOM does rather than a light-on-dark of its own — which is
    // what made it the one thing in the scene that ignored the theme.
    bubble: read("--color-solid-2", 0x27313d),
    bubbleText: read("--color-text", 0xe6eaee),
    lamp: read("--room-lamp", 0xffd79a),
    lampAlpha: alpha("--room-lamp-alpha", 0.6),
    window: read("--room-window", 0x7fb6ec),
    windowAlpha: alpha("--room-window-alpha", 0.3),
    coatGinger: read("--coat-ginger", 0xde9455),
    coatGrey: read("--coat-grey", 0x93a3b5),
    coatCream: read("--coat-cream", 0xedd9ba),
    coatTux: read("--coat-tux", 0x2f3946),
  };
}
