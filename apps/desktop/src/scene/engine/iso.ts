/**
 * Isometric projection and seat placement (PROJECT_BRIEF.md §3: 2.5D, not 3D).
 *
 * Seat *positions* live here rather than on the backend, while the seat *count*
 * stays there. That split follows what each side needs the number for: the
 * validator has to reject a member sitting in a seat that does not exist, which
 * needs the count; arranging desks in a room is a rendering decision, and
 * putting coordinates in the database would freeze the art direction into a
 * migration.
 *
 * An unknown layout falls back to a generated grid rather than an empty room —
 * a team saved by a newer build still has to be watchable (§8).
 */

/** Half-width and half-height of one floor tile. 2:1 is the classic iso ratio. */
export const TILE_W = 64;
export const TILE_H = 32;

export interface Point {
  x: number;
  y: number;
}

/** Grid coordinates to screen. The whole 2.5D illusion is these two lines. */
export function toScreen(gx: number, gy: number): Point {
  return { x: (gx - gy) * TILE_W, y: (gx + gy) * TILE_H };
}

/** Where each seat sits on the grid, per layout. */
const ARRANGEMENTS: Record<string, Point[]> = {
  // Two rows of three facing each other across a gangway.
  open_desks: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ],
  // Four around one table.
  war_room: [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 2 },
    { x: 2, y: 2 },
  ],
  // Two rows of four.
  workshop: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
  ],
  // Two desks facing each other.
  duo: [
    { x: 0, y: 0 },
    { x: 0, y: 2 },
  ],
};

/** A square-ish grid, for a layout this build does not know or one that grew. */
function generated(seats: number): Point[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(seats)));
  return Array.from({ length: seats }, (_, i) => ({
    x: i % columns,
    y: Math.floor(i / columns) * 2,
  }));
}

export function seatPositions(layoutId: string | null, seats: number): Point[] {
  const known = layoutId ? ARRANGEMENTS[layoutId] : undefined;
  if (!known) return generated(seats);
  // A layout that gained seats since this build shipped still renders: the
  // known desks keep their places and the rest are appended (§8).
  if (seats <= known.length) return known.slice(0, seats);
  return [...known, ...generated(seats).slice(known.length)];
}

/** The floor tiles to draw, one ring wider than the furthest desk. */
export function floorExtent(positions: Point[]): { w: number; h: number } {
  const maxX = positions.reduce((m, p) => Math.max(m, p.x), 0);
  const maxY = positions.reduce((m, p) => Math.max(m, p.y), 0);
  return { w: maxX + 2, h: maxY + 2 };
}
