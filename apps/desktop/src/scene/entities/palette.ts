/**
 * How an `avatar_config` becomes a cat.
 *
 * The slots are the closed catalogue the backend serves and the generator is
 * validated against (§11), so every value here has a counterpart there. An
 * unknown value resolves to the first entry rather than to `undefined` — the
 * same fallback the rest of the frontend follows (§8), and the reason a
 * *replay* still draws something: `missions.roster_snapshot` was deliberately
 * left on the old human catalogue, so an old run's `body: "slim"` arrives here
 * as a slot this build does not have and quietly becomes the default cat.
 *
 * Two of the four slots cost no artwork, which is what makes 5 x 8 x 8 x 8
 * combinations tractable at all:
 *
 *   build   -> a scale multiplier
 *   palette -> a tint
 *   coat    -> one overlay layer over the base cat
 *   outfit  -> one overlay layer over the base cat
 *
 * So the sheet carries one cat, eight coats and eight outfits, not 2,560
 * characters.
 */

/**
 * Fur, markings, and what they wear.
 *
 * The four fur colours the stylesheet names — ginger, grey, cream and the
 * tuxedo dark — are **read from `--coat-*` at draw time** rather than written
 * here, because they differ per theme: the same tint does not read the same on
 * a dark floor and a light one, and two tables of it would be two answers to
 * "what colour is a ginger cat" (§2.1).
 *
 * The other four are still literals. There are eight palettes in the closed
 * catalogue and four tokens, so half of them have no counterpart in CSS yet;
 * inventing four more tokens to fill the gap would be deciding something the
 * theme has not said. Reported rather than guessed.
 *
 * `marking`, `cloth` and `trim` stay here throughout: they are shading against
 * the fur, not colours the room has an opinion about.
 */
export type CoatToken =
  "coatGinger" | "coatGrey" | "coatCream" | "coatTux" | null;

export const PALETTES: Record<
  string,
  {
    fur: number;
    marking: number;
    cloth: number;
    trim: number;
    token: CoatToken;
  }
> = {
  ginger: {
    fur: 0xde9455,
    marking: 0xb3652a,
    cloth: 0x7a5539,
    trim: 0xffd28a,
    token: "coatGinger",
  },
  charcoal: {
    fur: 0x2f3946,
    marking: 0x1c2029,
    cloth: 0x4a3b30,
    trim: 0x9aa0a8,
    token: "coatTux",
  },
  cream: {
    fur: 0xedd9ba,
    marking: 0xc4a982,
    cloth: 0x8a6244,
    trim: 0xfff0d6,
    token: "coatCream",
  },
  grey: {
    fur: 0x93a3b5,
    marking: 0x6b727a,
    cloth: 0x5a3d28,
    trim: 0xd4dae0,
    token: "coatGrey",
  },
  brown: {
    fur: 0x8a6244,
    marking: 0x5c3f2a,
    cloth: 0x6b4a32,
    trim: 0xd4a373,
    token: null,
  },
  snow: {
    fur: 0xf2ece4,
    marking: 0xcfc4b6,
    cloth: 0x7a5539,
    trim: 0xffffff,
    token: null,
  },
  ink: {
    fur: 0x33333d,
    marking: 0x1c1c24,
    cloth: 0x4a3b30,
    trim: 0x7d6f61,
    token: null,
  },
  smoke: {
    fur: 0x8b98a0,
    marking: 0x5d686f,
    cloth: 0x6b4a32,
    trim: 0xc3cdd4,
    token: null,
  },
};

/** Height and width multipliers per build. Proportions, not stats (§1.1) —
 *  and the reason five builds cost nothing to draw. */
export const BUILDS: Record<string, { h: number; w: number }> = {
  lithe: { h: 1.0, w: 0.82 },
  average: { h: 1.0, w: 1.0 },
  stocky: { h: 0.96, w: 1.24 },
  lanky: { h: 1.18, w: 0.92 },
  small: { h: 0.82, w: 0.94 },
};

/**
 * Fur patterns, described as what the overlay draws.
 *
 * `patch` is how much of the body the second colour covers, `face` whether the
 * marking reaches the face, `tailTip` whether the tail ends in it. Until the
 * sprite sheet exists these drive the primitive renderer; after it, they are
 * the row to pick out of the coat layer.
 */
export const COATS: Record<
  string,
  { patch: number; face: boolean; tailTip: boolean; fluffy: boolean }
> = {
  tabby: { patch: 0.45, face: true, tailTip: true, fluffy: false },
  tuxedo: { patch: 0.6, face: false, tailTip: false, fluffy: false },
  calico: { patch: 0.5, face: true, tailTip: false, fluffy: false },
  point: { patch: 0.3, face: true, tailTip: true, fluffy: false },
  spotted: { patch: 0.25, face: false, tailTip: true, fluffy: false },
  shaggy: { patch: 0.35, face: false, tailTip: true, fluffy: true },
  sleek: { patch: 0.15, face: false, tailTip: false, fluffy: false },
  patched: { patch: 0.55, face: true, tailTip: false, fluffy: true },
};

/** Outfit silhouettes: how far the garment falls and whether it has a collar. */
export const OUTFITS: Record<
  string,
  { hem: number; collar: boolean; belt: boolean }
> = {
  lab_coat: { hem: 1.15, collar: true, belt: false },
  hoodie: { hem: 0.86, collar: false, belt: false },
  blazer: { hem: 0.94, collar: true, belt: false },
  apron: { hem: 1.1, collar: false, belt: true },
  overalls: { hem: 1.0, collar: false, belt: true },
  uniform: { hem: 0.92, collar: true, belt: true },
  vest: { hem: 0.8, collar: true, belt: false },
  scarf: { hem: 0.7, collar: true, belt: false },
};

function pick<T>(table: Record<string, T>, key: string | undefined): T {
  return (key && table[key]) || table[Object.keys(table)[0]!]!;
}

export interface Look {
  palette: (typeof PALETTES)[string];
  build: (typeof BUILDS)[string];
  coat: (typeof COATS)[string];
  outfit: (typeof OUTFITS)[string];
  /** The catalogue values themselves, for picking sprite rows out of the
   *  sheet. Kept beside the resolved shapes so a caller that draws from art
   *  and one that draws from primitives read the same object. */
  keys: { build: string; coat: string; outfit: string; palette: string };
}

export function lookFor(avatar: Record<string, string>): Look {
  const key = (table: Record<string, unknown>, value: string | undefined) =>
    value && value in table ? value : Object.keys(table)[0]!;
  return {
    palette: pick(PALETTES, avatar.palette),
    build: pick(BUILDS, avatar.build),
    coat: pick(COATS, avatar.coat),
    outfit: pick(OUTFITS, avatar.outfit),
    keys: {
      build: key(BUILDS, avatar.build),
      coat: key(COATS, avatar.coat),
      outfit: key(OUTFITS, avatar.outfit),
      palette: key(PALETTES, avatar.palette),
    },
  };
}
