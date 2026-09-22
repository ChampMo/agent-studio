/**
 * The room: its colours, read from the stylesheet, and how it is drawn.
 *
 * **Drawn, not a picture.** A room drawing arrived with the rest of the art
 * and was set aside, for two reasons that turned out to be one. It was a
 * fixed cream-and-pink, so in the dusk theme every label over it went
 * near-white on a pale wall; and it was one square image, so a six-desk team
 * either shrank the desks below the width of a cat's head or spilled past the
 * walls. A room that is *drawn* follows the theme the way the rest of the
 * scene does, and is exactly as wide as the seats need it to be — the same
 * reason the floor was always drawn from `floorExtent` rather than loaded.
 *
 * What is drawn borrows the delivered art's style rather than its pixels: flat
 * fills, a two-tone checker on the floor, one or two pixels of ink around the
 * silhouette, a skirting band along the wall base, and a sparse scatter of
 * dots on the walls where the drawing had them. Antialiasing is off on the
 * app, so the edges land as hard as the cats'.
 *
 * **Colours come from the stylesheet.** Pixi takes numbers, the theme lives in
 * CSS variables, and there is exactly one honest way to keep them from
 * drifting: ask the document. A second table of hex values in TypeScript would
 * be a second answer to "what colour is the floor", and the one nobody was
 * looking at would be the wrong one (§2.1) — the mistake this codebase has
 * already made with `activeId`, `can_run` and `lookFor`. So these are
 * *derived* tokens, declared in `index.css` beside the ones the DOM uses and
 * resolved here at draw time. Switching theme redraws the scene because the
 * values it reads have changed, not because anything told it to.
 */
import type { Graphics } from "pixi.js";

import {
  TILE_H,
  TILE_W,
  WALL_H,
  floorCorners,
  toScreen,
  type Point,
} from "../engine/iso";

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
  /** The two back walls: the one the light reaches, and the one in its own
   *  shadow. Two tokens rather than one darkened in code, because how far
   *  apart they sit is a theme decision — dusk wants less contrast than a
   *  sunlit afternoon. */
  wall: number;
  wallSide: number;
  /** The scatter on the walls. A shade of the wall, never a colour that means
   *  something elsewhere. */
  wallDot: number;
  /** The skirting band where wall meets floor. */
  dado: number;
  deskTop: number;
  deskSide: number;
  screen: number;
  paper: number;
  metal: number;
  danger: number;
  /** "It is your turn." The same amber the rest of the app reserves for a
   *  question waiting on the reader — the room draws a ring in it and uses it
   *  for nothing else, so the colour keeps meaning one thing (§18.3). */
  attn: number;
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
    wall: read("--room-wall", 0x293847),
    wallSide: read("--room-wall-side", 0x212e3c),
    wallDot: read("--room-wall-dot", 0x354a5f),
    dado: read("--room-dado", 0x5a4640),
    deskTop: read("--room-desk-top", 0x9a6a40),
    deskSide: read("--room-desk-side", 0x6a4728),
    screen: read("--color-accent", 0x4fc3d9),
    paper: read("--room-paper", 0xe6eaee),
    metal: read("--room-metal", 0x7e8b99),
    danger: read("--color-stop", 0xf0776a),
    attn: read("--color-attn", 0xf5b942),
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

/** Height of the skirting band along each wall's base. */
const DADO_H = 9;
/** Ink weight around the room's silhouette and the seam between the walls. */
const EDGE_W = 2;

/**
 * A small deterministic scatter.
 *
 * Not `Math.random()`: the room is redrawn on every theme change and every
 * layout change, and dots that moved each time would read as flicker. The same
 * wall gets the same dots every draw.
 */
function* scatter(seed: number, count: number): Generator<[number, number]> {
  let s = seed >>> 0 || 1;
  const next = () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < count; i += 1) yield [next(), next()];
}

function poly(g: Graphics, pts: Point[]): Graphics {
  const [first, ...rest] = pts;
  if (!first) return g;
  g.moveTo(first.x, first.y);
  for (const p of rest) g.lineTo(p.x, p.y);
  return g.closePath();
}

/** A point `u` of the way along the base of a wall, lifted `v` of its height. */
function onWall(base0: Point, base1: Point, u: number, v: number): Point {
  return {
    x: base0.x + (base1.x - base0.x) * u,
    y: base0.y + (base1.y - base0.y) * u - WALL_H * v,
  };
}

/**
 * Draw the whole room into one Graphics: walls, skirting, floor, outlines.
 *
 * Everything here is behind every character, which is what lets it be one
 * object at one z-index: this room has only the two *back* walls, so nothing
 * on the floor can ever be behind any of it.
 */
export function drawRoom(
  g: Graphics,
  extent: { w: number; h: number },
  paint: RoomColours,
): void {
  const { w, h } = extent;
  const { top, left, right, bottom } = floorCorners(extent);
  const up = (p: Point): Point => ({ x: p.x, y: p.y - WALL_H });

  g.clear();

  // ---- walls ----
  // The left wall takes the daylight, the right one is in its own shadow: the
  // same direction the floor's wash comes from, so the room is lit once.
  poly(g, [top, left, up(left), up(top)]).fill({ color: paint.wall });
  poly(g, [top, right, up(right), up(top)]).fill({ color: paint.wallSide });

  // ---- the scatter the drawing had on its walls ----
  // Sparse, deterministic, and kept off the bottom third so it never crowds
  // the skirting or reads as something sitting on the floor.
  for (const [wall, base1, seed] of [
    [top, left, 0x9e3779b9] as const,
    [top, right, 0x7f4a7c15] as const,
  ]) {
    const along = Math.hypot(base1.x - wall.x, base1.y - wall.y);
    const count = Math.round((along / TILE_W) * 6);
    for (const [u, v] of scatter(seed, count)) {
      const p = onWall(wall, base1, 0.06 + u * 0.88, 0.38 + v * 0.5);
      g.rect(Math.round(p.x), Math.round(p.y), 2, 2).fill({ color: paint.wallDot });
    }
  }

  // ---- skirting ----
  poly(g, [
    top,
    left,
    { x: left.x, y: left.y - DADO_H },
    { x: top.x, y: top.y - DADO_H },
  ]).fill({ color: paint.dado });
  poly(g, [
    top,
    right,
    { x: right.x, y: right.y - DADO_H },
    { x: top.x, y: top.y - DADO_H },
  ]).fill({ color: paint.dado });

  // ---- floor ----
  for (let gx = -1; gx < w; gx += 1) {
    for (let gy = -1; gy < h; gy += 1) {
      const p = toScreen(gx, gy);
      // Daylight falls from the top-right corner, the same direction as the
      // one wash left on the page behind the app. Applied per tile as a
      // second pass rather than as a gradient over the whole floor: the floor
      // is a grid of flat diamonds and a smooth ramp across it would be the
      // one soft edge in a scene made entirely of hard ones.
      const lit = Math.max(0, 1 - (gx + (h - 1 - gy)) / (w + h));
      const tile = () =>
        g
          .moveTo(p.x, p.y)
          .lineTo(p.x + TILE_W, p.y + TILE_H)
          .lineTo(p.x, p.y + TILE_H * 2)
          .lineTo(p.x - TILE_W, p.y + TILE_H)
          .closePath();
      tile().fill({ color: (gx + gy) % 2 === 0 ? paint.floorA : paint.floorB });
      if (lit > 0.05) {
        tile().fill({ color: paint.window, alpha: lit * paint.windowAlpha });
      }
    }
  }

  // ---- ink ----
  // The silhouette first, at the weight the drawn cats carry, then the two
  // lines that make it a corner: the seam between the walls and the edge
  // where each wall meets the floor.
  poly(g, [up(top), up(right), right, bottom, left, up(left)]).stroke({
    color: paint.ink,
    width: EDGE_W,
    alignment: 0.5,
  });
  g.moveTo(top.x, top.y).lineTo(top.x, top.y - WALL_H).stroke({
    color: paint.ink,
    width: EDGE_W,
  });
  g.moveTo(left.x, left.y)
    .lineTo(top.x, top.y)
    .lineTo(right.x, right.y)
    .stroke({ color: paint.ink, width: 1, alpha: 0.7 });
}

/** One piece of furniture against the walls, and where it goes. */
export interface DecorSpot {
  /** The file under `art/room/`, without the extension. */
  piece: "window" | "bookcase" | "shelf" | "plant" | "cooler";
  /** Where the piece's *foot* lands, in world units — the lowest ink in its
   *  picture, which `roomArt.ts` measures. */
  x: number;
  y: number;
  /** How tall the piece stands, in world units. In tiles rather than as a
   *  share of the wall, so raising the wall does not grow the furniture. */
  height: number;
  /** True for a piece whose base is a flat line — a pot, a stand — rather
   *  than one drawn along the wall at 2:1. Its middle on the skirting line
   *  would leave half the base over the wall, so the renderer sets it a
   *  little into the room until the whole base is on the floor. */
  flat: boolean;
}

/**
 * Where the delivered decor stands, given a floor this big.
 *
 * Pure geometry so it can be tested without a renderer. The pieces are fixed
 * for every team — a plant claims nothing about the run, so there is nothing
 * for it to be derived from — and they keep to the walls and the two far
 * corners, leaving the floor to the desks.
 */
export function decorSpots(extent: { w: number; h: number }): DecorSpot[] {
  const { top, left, right } = floorCorners(extent);
  // `u` is how far along the wall's base, 0 at the far corner and 1 at the
  // near one; `lift` is how far up the wall, in world pixels — zero for a
  // piece that stands on the floor.
  const at = (a: Point, b: Point, u: number, lift = 0) =>
    onWall(a, b, u, lift / WALL_H);
  // Heights in tiles. A bookcase stands about three tiles, a water cooler
  // comes up to somebody's shoulder, a plant to their knee. The window hangs
  // low enough on the near half of the right wall to stay in the pane when
  // the camera fills it with the floor (`floorBounds`).
  return [
    { piece: "window", ...at(top, right, 0.55, TILE_H * 2), height: TILE_H * 3, flat: false },
    { piece: "bookcase", ...at(top, left, 0.4, TILE_H * -0.7), height: TILE_H * 5, flat: false },
    // The shelf came with its rug beside it in one picture, so the two go in
    // together: against the right wall, between the head of the table and the window.
    { piece: "shelf", ...at(top, right, 0.8, TILE_H * -0.5), height: TILE_H * 7, flat: false },
    { piece: "cooler", ...at(top, left, 0.7), height: TILE_H * 5, flat: true },
    { piece: "plant", ...at(top, right, 0.3), height: TILE_H * 3, flat: true },
  ];
}
