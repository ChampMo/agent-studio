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
 * Five slots. What each one costs is different, and this table is only the
 * *fallback* renderer's half of it — `catArt.ts` says what the drawn artwork
 * costs, which is not the same answer:
 *
 *   breed    -> one overlay layer, plus the tint that goes with it
 *   size     -> a scale multiplier, no frames at all
 *   headwear -> nothing here. Drawn artwork only.
 *   glasses  -> nothing here. Drawn artwork only.
 *   collar   -> nothing here either. The sheet has no collar art, so a cat
 *               drawn from sprites wears none rather than one improvised
 *               from a layer meant for something else (§8).
 *
 * Three of the five are drawn artwork alone, and that is deliberate rather
 * than unfinished. The sprite sheet is what draws a cat this build has no
 * picture for — an old `roster_snapshot`, a breed whose file never landed —
 * and improvising a hat out of a row meant for something else would be this
 * build inventing a look nobody chose. A composited cat wears nothing, which
 * is the honest version of "no art for that".
 *
 * `breed` folds together what used to be `coat` and `palette`. They were
 * independent, which meant `coat: tuxedo` could be picked with
 * `palette: ginger` — a tuxedo is black and white by definition, so that pair
 * described a cat which does not exist. Pattern and colouring travel together
 * now, which is how they travel on an actual cat, and the sheet does not grow
 * because the colouring was always a tint.
 *
 * `headwear` and `glasses` replaced the single `prop` slot when the drawings
 * arrived: they share no pixels, so one slot could only ever show one of two
 * things a cat can plainly wear at once.
 */

/**
 * The breeds: a pattern and the colouring that comes with it.
 *
 * The four fur colours the stylesheet names — ginger, grey, cream and the
 * tuxedo dark — are **read from `--coat-*` at draw time** rather than written
 * here, because they differ per theme: the same tint does not read the same on
 * a dark floor and a light one, and two tables of it would be two answers to
 * "what colour is a ginger cat" (§2.1).
 *
 * The other four are still literals. Eight breeds and four tokens, so half of
 * them have no counterpart in CSS yet; inventing four more tokens to fill the
 * gap would be deciding something the theme has not said. Reported rather than
 * guessed.
 *
 * `marking`, `cloth` and `trim` stay here throughout: they are shading against
 * the fur, not colours the room has an opinion about.
 *
 * `layer` is the row on the sprite sheet. It is kept separate from the breed's
 * own name because the art is a *pattern* and several breeds could one day
 * share one — the name is the choice a person made, the layer is what gets
 * drawn.
 */
export type CoatToken =
  "coatGinger" | "coatGrey" | "coatCream" | "coatTux" | null;

export interface Breed {
  /** Which pattern row on the sheet. */
  layer: string;
  fur: number;
  marking: number;
  cloth: number;
  trim: number;
  token: CoatToken;
}

export const BREEDS: Record<string, Breed> = {
  marmalade: {
    layer: "marmalade",
    fur: 0xf2a259,
    marking: 0xfce6c8,
    cloth: 0x8a5a3c,
    trim: 0xfff0dc,
    token: null,
  },
  siamese: {
    layer: "point",
    fur: 0xf2ece4,
    marking: 0x6b5b4c,
    cloth: 0x7a5539,
    trim: 0xffffff,
    token: null,
  },
  bombay: {
    layer: "sleek",
    fur: 0x33333d,
    marking: 0x1c1c24,
    cloth: 0x4a3b30,
    trim: 0x7d6f61,
    token: null,
  },
  tuxedo: {
    layer: "tuxedo",
    fur: 0x2f3946,
    marking: 0x1c2029,
    cloth: 0x4a3b30,
    trim: 0x9aa0a8,
    token: "coatTux",
  },
};

/**
 * The collars, as names only.
 *
 * A list rather than a table because there is nothing to put in the table: the
 * sprite sheet holds no collar art, so a cat drawn from sprites wears none and
 * the only thing anyone needs from this slot is which file to ask for.
 *
 * Four were drawn and they differ only in colour — the bell on each is the
 * same — so the values are the colours. The previous list named *kinds* of
 * collar (bell, tag, ribbon, studded) and was written before any existed;
 * nothing was ever drawn for it and no row in the database holds one.
 *
 * `none` is first, so an unreadable value falls back to no collar rather than
 * to one this build picked (§8).
 */
export const COLLARS = ["none", "blue", "green", "pink", "red"] as const;

/**
 * How round the cat is.
 *
 * **Two, because two were drawn.** `Face-normal` and `Face-fat` are separate
 * pictures of each cat, so the numbers here are no longer what makes a cat
 * fat — the drawing is. They survive for the two places a drawing may not be
 * available: the sprite-sheet fallback, which has one body and has to squash
 * it, and a breed whose `fat` file has not landed yet.
 *
 * That is why `fat` is a real multiplier rather than `1.0`. If it were 1.0 a
 * half-delivered breed would draw its fat cat at exactly the normal cat's
 * width, and the slot would claim to do something it does not (§1.1). It is
 * measured off the delivered art: the fat face inks 2px wider than the normal
 * one at the same height, and the squash exaggerates that to roughly where
 * the real drawing sits.
 *
 * The heavy end loses a little height on purpose. A cat that only grew wider
 * reads as stretched; one that settles slightly as it widens reads as heavy.
 */
export const SIZES: Record<string, { h: number; w: number }> = {
  normal: { h: 1.0, w: 1.0 },
  fat: { h: 0.97, w: 1.22 },
};

/**
 * What is on top of the head: a bow, a cap, or a small bow on each ear.
 *
 * One slot for three shapes because they all want the same place. Measured,
 * not assumed: a head bow over the ear bows shares 220 pixels, and a head
 * bow over a cap 216. A value names the shape and the colour, since "red"
 * alone would not say which of three red things was meant.
 *
 * Names only, like the collars, because there is nothing for a table to
 * hold — the sprite fallback draws no accessory at all, so the only thing
 * anyone needs from this slot is which file to ask for.
 *
 * `none` is first, so an unreadable value falls back to a bare head rather
 * than to a hat this build picked (§8).
 */
export const HEADWEAR = [
  "none",
  "bow_red",
  "bow_amber",
  "bow_green",
  "bow_jade",
  "bow_rose",
  "bow_violet",
  "bow_orchid",
  "bow_blue",
  "bow_pink",
  "cap_tan",
  "cap_brown",
  "ears_blue",
  "ears_violet",
  "ears_rose",
  "ears_brown",
  "ears_amber",
] as const;

/**
 * Glasses, in the seven colours that were drawn.
 *
 * Its own slot rather than a value in `HEADWEAR`, because glasses sit on the
 * eyes and share **zero** pixels with the cap and zero with the ear bows. A
 * single accessory slot would have made a cat choose between two things it
 * can obviously wear together, and thrown away most of what was drawn.
 */
export const GLASSES = [
  "none",
  "blue",
  "red",
  "amber",
  "green",
  "teal",
  "brown",
  "pink",
] as const;

function pick<T>(table: Record<string, T>, key: string | undefined): T {
  return (key && table[key]) || table[Object.keys(table)[0]!]!;
}

export interface Look {
  breed: Breed;
  size: (typeof SIZES)[string];
  keys: {
    breed: string;
    size: string;
    headwear: string;
    glasses: string;
    collar: string;
  };
}

/**
 * The five slots, resolved, with a fallback for every one.
 *
 * The fallback is what lets a **replay** draw anything at all. Old missions
 * hold four-slot configs frozen into `roster_snapshot`, which is deliberately
 * never migrated (§5.1) — so `coat: "patched"` arrives here as a slot this
 * build has never heard of, and every lookup quietly answers with the first
 * entry. That is this build saying it has no art for what was recorded, which
 * is the honest answer, rather than crashing or inventing one (§8).
 */
export function lookFor(avatar: Record<string, string>): Look {
  const key = (table: Record<string, unknown>, value: string | undefined) =>
    value && value in table ? value : Object.keys(table)[0]!;
  // `cat` was this same choice under another name, for the one build that had
  // a single slot. The values never changed, so reading it keeps a config
  // written by that build looking like itself instead of falling back to the
  // default cat — the same reason `migrate_avatar` carries `cat -> breed`.
  const breed = avatar.cat ?? avatar.breed;
  // Three lists rather than three tables, so one helper answers all of them:
  // a value that is in the list is itself, and anything else is the first
  // entry, which is always `none`.
  const listed = (list: readonly string[], value: string | undefined) =>
    value && list.includes(value) ? value : list[0]!;
  return {
    breed: pick(BREEDS, breed),
    size: pick(SIZES, avatar.size),
    keys: {
      breed: key(BREEDS, breed),
      size: key(SIZES, avatar.size),
      // `prop` is not read as a fallback for either of these. It was one
      // slot holding a value that now means a hat *or* glasses, and this
      // side cannot tell which without duplicating `PROP_SPLIT` — a second
      // copy of the migration, in the renderer, disagreeing with the first
      // the day either changed (§2.1). A config the migration has not been
      // over draws a bare cat, which is this build saying it has no art for
      // what was recorded (§8).
      headwear: listed(HEADWEAR, avatar.headwear),
      glasses: listed(GLASSES, avatar.glasses),
      collar: listed(COLLARS, avatar.collar),
    },
  };
}

