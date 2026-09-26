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

/**
 * How tall the two back walls stand, in world pixels.
 *
 * Four and a half tiles. The camera frames the **floor** (`floorBounds`), so
 * in a wide pane the walls run off the top edge and only the two corners of
 * the pane show how tall they are — three tiles left a slab of page showing
 * above each wall. Nothing that stands on the floor is sized from this: the
 * decor is measured in tiles, so raising the wall does not grow the bookcase.
 */
export const WALL_H = TILE_H * 6;

export interface Point {
  x: number;
  y: number;
}

/** Grid coordinates to screen. The whole 2.5D illusion is these two lines. */
export function toScreen(gx: number, gy: number): Point {
  return { x: (gx - gy) * TILE_W, y: (gx + gy) * TILE_H };
}

/**
 * Where each seat sits on the grid, per layout.
 *
 * **Seat 0 is the head of the table**, and every arrangement is built around
 * that: the head is the one desk at the far corner of the room, and the rest
 * fill the floor in front of it.
 *
 * That is not decoration. The leader is the one member the orchestrator never
 * assigns a task to, so "who is in charge here" is a real fact about how the
 * run will behave, and a row of identical desks was the one arrangement that
 * could not show it.
 *
 * **The head belongs to the leader, not to seat 0.** This used to say that
 * `role_in_team` made seat 0 the leader, and nothing anywhere enforces that:
 * the validator checks there is exactly one leader and says nothing about
 * where they sit. A real five-person team on this machine has its leader in
 * **seat 4**, so the room had been drawing the QA Engineer at the head of the
 * table and the project manager down the side — the picture stating the wrong
 * thing about who is in charge (§1). `seatPositions` takes the leader's seat
 * and gives them the head; everyone else keeps their own place.
 *
 * **Three tiles apart, on a grid.** A drawn desk with its cat, the name above
 * and the legs below is a tile wide and two and a half tall on screen, so
 * two tiles apart put one desk's legs on the next desk's name. And a grid
 * rather than a long table, because the floor is a diamond: an eight-seat
 * room laid out as two long rows had every desk in a narrow band down the
 * middle and the whole front half of the floor empty. The grid is sized to
 * the seats, and `floorExtent` draws the floor around it, so the room is as
 * big as the desks and no bigger.
 *
 * Positions live here rather than on the backend, while the seat *count* stays
 * there. Each side owns the number it needs: the validator has to reject a
 * member sitting in a seat that does not exist, and arranging desks is a
 * rendering decision that would otherwise be frozen into a migration.
 *
 * Read the numbers as screen space via `toScreen`: a pair sharing `gx + gy` sits
 * level with each other, and `gx - gy` is how far left or right of the middle
 * they are. To rearrange a room, edit the list — the order is the seat order.
 */
const ARRANGEMENTS: Record<string, Point[]> = {
  // Head at the far corner, a pair in front of it, one in the middle, a wider
  // pair below. Read as depth (`gx + gy`) that is 0, 3, 3, 6, 9, 9 — four
  // evenly spaced rows.
  //
  // The sixth desk used to sit at the near corner, at depth 12 with the next
  // deepest at 9 and **nothing at all at depth 6** — a ring with a hole through
  // the middle of it and one cat two rows out in front of everybody. (Not off
  // the floor: at (6,6) the floor is nine tiles a side, so there were two clear
  // tiles beyond it. The hole is the part that showed.)
  //
  // `workshop` had already met this and written the answer down — it fills the
  // middle and leaves the near corner open — so the six-seat room was the one
  // arrangement still doing the opposite of its own note.
  //
  // Five of them is this without the middle, which is symmetric — and a
  // five-person team is the common case, so that stays true.
  open_desks: [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 0, y: 3 },
    { x: 6, y: 3 },
    { x: 3, y: 6 },
    { x: 3, y: 3 },
  ],
  // A diamond of four.
  war_room: [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 0, y: 3 },
    { x: 3, y: 3 },
  ],
  // Eight of a three-by-three: head at the far corner, then rows of two,
  // three and two. The near corner is left open — a ring with an empty
  // middle read as a hole in the room, and a desk at the very front sat on
  // the floor's edge.
  workshop: [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 0, y: 3 },
    { x: 3, y: 3 },
    { x: 6, y: 3 },
    { x: 3, y: 6 },
    { x: 6, y: 0 },
    { x: 0, y: 6 },
  ],
  // Head and foot, one in front of the other.
  duo: [
    { x: 0, y: 0 },
    { x: 3, y: 3 },
  ],
};

/** How many tiles apart the desks stand, in both directions. */
const STEP = 3;

/**
 * A grid of any size, for a layout this build does not know, one that grew
 * past its arrangement, and the spare cells a known layout needs for the
 * seats it gained (§8).
 *
 * The smallest square grid that holds the count, in the order the room fills:
 * row by row from the far corner, the middle of each row first. The head is
 * still the one desk at the top and whatever fits below it is balanced
 * rather than lopsided.
 */
function grid(count: number): Point[] {
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  const cells: Point[] = [];
  for (let i = 0; i < side; i += 1) {
    for (let j = 0; j < side; j += 1) cells.push({ x: i, y: j });
  }
  cells.sort(
    (a, b) =>
      a.x + a.y - (b.x + b.y) ||
      Math.abs(a.x - a.y) - Math.abs(b.x - b.y) ||
      a.x - a.y - (b.x - b.y),
  );
  return cells.map((c) => ({ x: c.x * STEP, y: c.y * STEP }));
}

function generated(seats: number): Point[] {
  return grid(seats).slice(0, seats);
}

/**
 * The known desks, then grid cells they do not already use for the rest.
 *
 * Not `generated(seats)` from the known length on: that hands out cells the
 * arrangement is already sitting in, and two desks on one tile draw as one
 * desk with two cats.
 */
function extended(known: Point[], seats: number): Point[] {
  const used = new Set(known.map((p) => `${p.x},${p.y}`));
  const out = [...known];
  // A grid that holds every seat plus every known desk has at least `seats`
  // cells the known desks are not in.
  for (const cell of grid(seats + known.length)) {
    if (out.length >= seats) break;
    if (!used.has(`${cell.x},${cell.y}`)) out.push(cell);
  }
  return out.slice(0, seats);
}

export function seatPositions(
  layoutId: string | null,
  seats: number,
  /** Which seat the leader sits in, so the head can be theirs. Omitted where
   *  there is no leader — a solo run, or a team saved without one, which the
   *  builder allows and the launcher refuses (§5.2). */
  leaderSeat?: number | null,
): Point[] {
  const known = layoutId ? ARRANGEMENTS[layoutId] : undefined;
  const base = !known
    ? generated(seats)
    : // A layout that gained seats since this build shipped still renders: the
      // known desks keep their places and the rest are appended (§8).
      seats <= known.length
      ? known.slice(0, seats)
      : extended(known, seats);

  return headForLeader(base, leaderSeat);
}

/**
 * Where the desks actually go, for the members actually here.
 *
 * `seatPositions` answers for every seat the layout has; this answers for the
 * seats that are *occupied*, which is what the floor is drawn around. A team
 * of two on a six-seat layout used to get a six-desk room with two desks in
 * one corner of it — the room was sized to the chairs nobody was in.
 *
 * One or two members get a small room of their own regardless of layout: a
 * single desk in the middle, or two desks side by side with the leader on
 * the left. Three or more take the layout's own places, and the floor is
 * sized to the desks in use.
 *
 * `bySeat` is indexed by seat, so the renderer keeps asking by seat; an
 * unoccupied seat falls back to the head, which is never drawn for a seat
 * with nobody in it. `used` is the desks in use, for the floor and the
 * camera.
 */
export function roomSeats(
  layoutId: string | null,
  seats: number,
  occupied: number[],
  leaderSeat?: number | null,
): { bySeat: Point[]; used: Point[] } {
  const here = [...new Set(occupied)].sort((a, b) => a - b);
  if (here.length > 0 && here.length <= SMALL.length) {
    // The leader takes the first place; everyone else keeps their order.
    const order =
      leaderSeat !== undefined && leaderSeat !== null && here.includes(leaderSeat)
        ? [leaderSeat, ...here.filter((seat) => seat !== leaderSeat)]
        : here;
    const places = SMALL[here.length - 1]!;
    const bySeat: Point[] = [];
    order.forEach((seat, i) => {
      bySeat[seat] = places[i]!;
    });
    const head = places[0]!;
    for (let i = 0; i < Math.max(seats, here.length); i += 1) bySeat[i] ??= head;
    return { bySeat, used: order.map((_, i) => places[i]!) };
  }
  const all = seatPositions(layoutId, seats, leaderSeat);
  const head = all[0] ?? { x: 0, y: 0 };
  const bySeat = all.map((point) => point ?? head);
  const used = here.map((seat) => bySeat[seat] ?? head);
  return { bySeat, used: used.length > 0 ? used : all };
}

/** Rooms for one and for two, in tiles. Centred in the floor `floorExtent`
 *  draws for them: one desk in the middle; two side by side on one row, the
 *  leader on the left, two tiles apart: close, with a sliver of floor between. */
const SMALL: Point[][] = [
  [{ x: 2, y: 2 }],
  [
    { x: 1, y: 3 },
    { x: 3, y: 1 },
  ],
];

/**
 * Give the head of the table to the leader.
 *
 * A swap rather than a rotation: the leader takes the head and whoever was at
 * the head takes the leader's old desk. Everyone else stays exactly where they
 * were, so a run does not reshuffle its whole room to move one person.
 *
 * Out of range, absent, or already at the head — nothing moves. An index this
 * build cannot place is not a reason to rearrange the furniture (§8).
 */
export function headForLeader(
  positions: Point[],
  leaderSeat?: number | null,
): Point[] {
  if (
    leaderSeat === undefined ||
    leaderSeat === null ||
    leaderSeat <= 0 ||
    leaderSeat >= positions.length
  ) {
    return positions;
  }
  const out = [...positions];
  const head = out[0]!;
  out[0] = out[leaderSeat]!;
  out[leaderSeat] = head;
  return out;
}

/**
 * Where whoever has the floor stands (§12 M7).
 *
 * The centroid of the desks, stepped toward the viewer so the character is in
 * front of the furniture rather than inside it. Derived from the seats rather
 * than listed per layout: a layout this build has never seen still has a middle,
 * so there is no arrangement in which the walk has nowhere to go (§8).
 */
export function floorSpot(positions: Point[]): Point {
  if (positions.length === 0) return { x: 0.6, y: 0.6 };
  const sum = positions.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), {
    x: 0,
    y: 0,
  });
  return {
    x: sum.x / positions.length + 0.6,
    y: sum.y / positions.length + 0.6,
  };
}

/**
 * Where the camera looks: the character with the floor, or the middle of the
 * room when nobody has it.
 *
 * Pure, and separate from the renderer, so "an agent nobody can place does not
 * send the camera off the map" is a test rather than something you catch by
 * watching (§8).
 */
export function cameraTarget(
  focusSeatIndex: number | null,
  focusPlace: "seat" | "floor",
  positions: Point[],
  /** The desks the room is drawn around, when that is not every seat. */
  room: Point[] = positions,
): Point {
  const centre = roomCentre(room);
  if (focusSeatIndex === null) return centre;
  if (focusPlace === "floor") {
    const spot = floorSpot(room);
    return toScreen(spot.x, spot.y);
  }
  const cell = positions[focusSeatIndex];
  // A seat the layout does not have is not a reason to look at nothing.
  if (!cell) return centre;
  return toScreen(cell.x, cell.y);
}

/** The middle of the room in screen space. */
/**
 * The four corners of the drawn floor, for a grid this big.
 *
 * Derived from the same tile loop `drawRoom` runs — tiles from `-1` to `w-1`
 * and `-1` to `h-1` — so the walls, the outline and the decor all stand on
 * exactly the diamond the floor fills, rather than on a second opinion of
 * where it ends.
 */
export function floorCorners(extent: { w: number; h: number }): {
  top: Point;
  left: Point;
  right: Point;
  bottom: Point;
} {
  const { w, h } = extent;
  return {
    top: { x: 0, y: -2 * TILE_H },
    left: { x: -(h + 1) * TILE_W, y: (h - 1) * TILE_H },
    right: { x: (w + 1) * TILE_W, y: (w - 1) * TILE_H },
    bottom: { x: (w - h) * TILE_W, y: (w + h) * TILE_H },
  };
}

/**
 * The floor's box — the diamond the tiles fill, walls excluded — for the
 * camera to fit.
 *
 * The walls are left out on purpose. Fitting them too made the desks small in
 * every pane that is wider than it is tall, which is every pane this scene is
 * shown in, and the desks are where everything that means something is. So
 * the default view fills the pane with the floor and lets the walls run off
 * the top; zooming out (wheel, `-`) still shows the whole room.
 */
export function floorBounds(positions: Point[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const c = floorCorners(floorExtent(positions));
  return { x: c.left.x, y: c.top.y, w: c.right.x - c.left.x, h: c.bottom.y - c.top.y };
}

/** Where the camera rests when nobody has the floor: the middle of the floor. */
export function roomCentre(positions: Point[]): Point {
  const b = floorBounds(positions);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * The floor tiles to draw: a square, one ring wider than the furthest desk.
 *
 * Square rather than fitted to each axis. A team whose desks happened to run
 * two tiles one way and three the other got a room shaped like a corridor,
 * and the shape of the room is not a fact about the team (§1.1) — every room
 * is the same room, sized to whoever is in it.
 */
export function floorExtent(positions: Point[]): { w: number; h: number } {
  const maxX = positions.reduce((m, p) => Math.max(m, p.x), 0);
  const maxY = positions.reduce((m, p) => Math.max(m, p.y), 0);
  // Two clear tiles in front of the nearest desk, one behind the furthest:
  // a desk's legs reach into the tile in front of it, so one tile there put
  // the front row on the floor's edge.
  // Never smaller than a four-desk room: a draft run has no roster yet, and
  // a floor of nothing, filled to the pane, is a wall of pixels.
  const side = Math.max(maxX, maxY, STEP) + FRONT_MARGIN + 1;
  return { w: side, h: side };
}

/** Floor tiles kept clear between the front row of desks and the edge. */
const FRONT_MARGIN = 2;
