/**
 * How an `avatar_config` becomes colours and proportions.
 *
 * The slots are the closed catalogue the backend serves and the generator is
 * validated against (§11), so every value here has a counterpart there. An
 * unknown value — an asset added by a newer build — resolves to the first entry
 * rather than to `undefined`, which is the same fallback rule the rest of the
 * frontend follows (§8).
 */

export const PALETTES: Record<string, { skin: number; hair: number; cloth: number; trim: number }> = {
  slate: { skin: 0xd8c3a5, hair: 0x2f3a4a, cloth: 0x475569, trim: 0x94a3b8 },
  amber: { skin: 0xe8c9a0, hair: 0x6b3f1d, cloth: 0xb45309, trim: 0xfcd34d },
  teal: { skin: 0xd6bfa8, hair: 0x1f3f3a, cloth: 0x0f766e, trim: 0x5eead4 },
  rose: { skin: 0xeccfc4, hair: 0x4a1f2f, cloth: 0x9f1239, trim: 0xfda4af },
  violet: { skin: 0xdcc7d8, hair: 0x2e1f4a, cloth: 0x6d28d9, trim: 0xc4b5fd },
  moss: { skin: 0xd3c6a0, hair: 0x2f3d1f, cloth: 0x4d7c0f, trim: 0xbef264 },
  sand: { skin: 0xe6d2b5, hair: 0x5c4a2f, cloth: 0xa16207, trim: 0xfde68a },
  ink: { skin: 0xc9c9d4, hair: 0x111827, cloth: 0x1f2937, trim: 0x64748b },
};

/** Height and width multipliers per body. Proportions, not stats (§1.1). */
export const BODIES: Record<string, { h: number; w: number }> = {
  slim: { h: 1.0, w: 0.82 },
  average: { h: 1.0, w: 1.0 },
  sturdy: { h: 0.96, w: 1.24 },
  tall: { h: 1.18, w: 0.92 },
  small: { h: 0.82, w: 0.94 },
};

/** Hair silhouettes, described as the shapes the renderer draws. */
export const HAIR: Record<string, { top: number; side: number; tail: boolean; hood: boolean }> = {
  short: { top: 0.34, side: 0.1, tail: false, hood: false },
  long: { top: 0.4, side: 0.5, tail: false, hood: false },
  ponytail: { top: 0.36, side: 0.14, tail: true, hood: false },
  buzz: { top: 0.16, side: 0.04, tail: false, hood: false },
  curly: { top: 0.5, side: 0.28, tail: false, hood: false },
  bun: { top: 0.44, side: 0.1, tail: false, hood: false },
  bald: { top: 0, side: 0, tail: false, hood: false },
  hooded: { top: 0.46, side: 0.44, tail: false, hood: true },
};

/** Outfit silhouettes: how far the garment falls and whether it has a collar. */
export const OUTFITS: Record<string, { hem: number; collar: boolean; belt: boolean }> = {
  lab_coat: { hem: 1.15, collar: true, belt: false },
  hoodie: { hem: 0.86, collar: false, belt: false },
  blazer: { hem: 0.94, collar: true, belt: false },
  robe: { hem: 1.25, collar: false, belt: true },
  overalls: { hem: 1.0, collar: false, belt: true },
  uniform: { hem: 0.92, collar: true, belt: true },
  armor: { hem: 0.9, collar: true, belt: true },
  cloak: { hem: 1.3, collar: true, belt: false },
};

function pick<T>(table: Record<string, T>, key: string | undefined): T {
  return (key && table[key]) || table[Object.keys(table)[0]!]!;
}

export interface Look {
  palette: (typeof PALETTES)[string];
  body: (typeof BODIES)[string];
  hair: (typeof HAIR)[string];
  outfit: (typeof OUTFITS)[string];
}

export function lookFor(avatar: Record<string, string>): Look {
  return {
    palette: pick(PALETTES, avatar.palette),
    body: pick(BODIES, avatar.body),
    hair: pick(HAIR, avatar.hair),
    outfit: pick(OUTFITS, avatar.outfit),
  };
}
