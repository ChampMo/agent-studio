/**
 * The drawn furniture, as textures the scene can put on a sprite — and where
 * each piece touches the floor.
 *
 * The room itself is drawn (`room.ts`); what stands in it was delivered as
 * pictures — a desk, a window, a bookcase, a plant, a water cooler — and this
 * loads those. It is the same shape as `picture.ts` for the cats, kept
 * separate because the two lists change for different reasons: a new breed
 * is a catalogue edit, a new bookcase is not.
 *
 * **A missing file is an answer, not a failure.** Each piece is asked for once
 * with a plain image request, quiet on a miss, and the texture is made from
 * the element that answered. A desk with no picture falls back to the
 * primitive it was always drawn with; decor with none is simply not there.
 *
 * **Where a piece stands is read off its ink, not assumed.** The pieces are
 * drawn in the room's own projection: the bookcase's base slopes up to the
 * right at 2:1, the same slope as the left wall it stands against. Anchoring
 * a sprite at the *canvas's* bottom-centre — the default, and what this did
 * — put that point six to eleven pixels below the drawing's real base, so
 * the whole bookcase hung that far above the skirting and read as floating.
 * The **foot** is the lowest ink row, at the middle of that row's run. It is
 * measured once when the picture arrives, the sprite is anchored there, and
 * that point is what gets set on the floor. A redrawn piece brings its own
 * foot with it; nothing here has to be re-measured by hand.
 */
import { Texture } from "pixi.js";

import { fetchImage } from "./artFetch";

const ROOM = "/art/room";

/** Everything that can stand in the room. Asked for at startup, all at once. */
export const PIECES = ["desk", "window", "bookcase", "shelf", "plant", "cooler"] as const;
export type Piece = (typeof PIECES)[number];

/** Where a picture touches the ground, as fractions of its width and height. */
export interface Foot {
  x: number;
  y: number;
}

/** Bottom-centre: what a piece with no measurable ink is placed by. */
const DEFAULT_FOOT: Foot = { x: 0.5, y: 1 };

export function piecePath(piece: Piece): string {
  return `${ROOM}/${piece}.png`;
}

const textures = new Map<string, Texture>();
const feet = new Map<string, Foot>();
let loading: Promise<void> | null = null;

/**
 * The lowest ink in a picture, from its pixels.
 *
 * Null when the pixels cannot be read — no document, no 2D context, a canvas
 * the browser refuses to hand back — and the caller falls back to the
 * bottom-centre, which is wrong by a few pixels rather than by a piece.
 */
function footOf(image: HTMLImageElement): Foot | null {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (!w || !h || typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    for (let y = h - 1; y >= 0; y -= 1) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < w; x += 1) {
        if ((data[(y * w + x) * 4 + 3] ?? 0) > 0) {
          if (first < 0) first = x;
          last = x;
        }
      }
      // The middle of the run, so a flat-bottomed pot stands on its centre
      // and a bookcase drawn at 2:1 stands on the one foot that is lowest.
      if (first >= 0) return { x: (first + last + 1) / 2 / w, y: (y + 1) / h };
    }
    return null;
  } catch {
    return null;
  }
}

async function one(piece: Piece): Promise<void> {
  const path = piecePath(piece);
  const image = await fetchImage(path);
  if (!image) return;
  // From the element just loaded, not from the URL again — one fetch, and
  // the bytes the texture is made of are the bytes that answered.
  const texture = Texture.from(image);
  // Same filtering as the cats. Furniture is scaled by the camera at every
  // zoom level, and a soft desk beside a crisp cat reads as a fault.
  texture.source.scaleMode = "nearest";
  textures.set(path, texture);
  const foot = footOf(image);
  if (foot) feet.set(path, foot);
}

/** Ask for every piece. Resolves when all have answered, present or not. */
export function loadRoomArt(): Promise<void> {
  if (loading) return loading;
  loading = Promise.all(PIECES.map(one)).then(() => undefined);
  return loading;
}

/** The texture for a piece, or undefined when no picture of it exists. */
export function pieceTexture(piece: Piece): Texture | undefined {
  return textures.get(piecePath(piece));
}

/** Where a piece's picture touches the ground. Bottom-centre until measured. */
export function pieceFoot(piece: Piece): Foot {
  return feet.get(piecePath(piece)) ?? DEFAULT_FOOT;
}
