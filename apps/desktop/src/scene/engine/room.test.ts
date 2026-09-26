/**
 * The shape of a full room, checked as geometry rather than by squinting.
 *
 * A six-person team drew a ring with a hole punched through the middle of it
 * and the sixth desk out on the floor's front edge. The rule that fixes it was
 * already written down for the eight-seat room — "a ring with an empty middle
 * read as a hole in the room, and a desk at the very front sat on the floor's
 * edge" — and the six-seat room was the one arrangement still doing the
 * opposite of its own note.
 *
 * Depth is `gx + gy` and side is `gx - gy`, so both are checkable numbers.
 */
import { describe, expect, it } from "vitest";

import { floorExtent, seatPositions } from "./iso";

const depth = (p: { x: number; y: number }) => p.x + p.y;
const side = (p: { x: number; y: number }) => p.x - p.y;

describe("a full six-seat room", () => {
  const seats = seatPositions("open_desks", 6, 0);

  it("puts the leader at the head", () => {
    expect(depth(seats[0]!)).toBe(0);
    expect(side(seats[0]!)).toBe(0);
  });

  it("leaves no empty row between the front and the back", () => {
    // Every desk sits on one of four evenly spaced rows, and each row is
    // occupied. A gap here is the hole: 0, 3, 9, 12 had nothing at 6.
    const rows = [...new Set(seats.map(depth))].sort((a, b) => a - b);
    expect(rows).toEqual([0, 3, 6, 9]);
  });

  it("sends nobody further forward than the front pair", () => {
    // The sixth desk used to sit at depth 12 with the next-deepest at 9 — one
    // cat two rows out in front of everybody, which is what made the room
    // read as lopsided. It is not "off the floor": at (6,6) the floor is nine
    // tiles a side, so there were two clear tiles beyond it. The first version
    // of this test asserted the edge and passed on the old arrangement too,
    // which is a test proving nothing.
    const rows = seats.map(depth);
    expect(Math.max(...rows)).toBe(9);
  });

  it("draws the same floor it always did", () => {
    // Sized off the largest coordinate, and seats 3 and 4 still reach 6 — so
    // moving the sixth desk inward does not shrink the room around it.
    expect(floorExtent(seats)).toEqual({ w: 9, h: 9 });
  });

  it("stands no two desks on one tile", () => {
    const cells = new Set(seats.map((p) => `${p.x},${p.y}`));
    expect(cells.size).toBe(seats.length);
  });

  it("is symmetric about the middle", () => {
    const sides = seats.map(side).sort((a, b) => a - b);
    expect(sides).toEqual([-3, -3, 0, 0, 3, 3]);
  });
});

describe("five of them, which is the common case", () => {
  // The five-person room must not change: it was already symmetric, and the
  // sixth desk is the only one that moved.
  const five = seatPositions("open_desks", 5, 0);

  it("is the same room it always was", () => {
    expect(five).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 0, y: 3 },
      { x: 6, y: 3 },
      { x: 3, y: 6 },
    ]);
  });
});

describe("the eight-seat room it borrowed the rule from", () => {
  const eight = seatPositions("workshop", 8, 0);

  it("also fills its middle", () => {
    expect(eight.some((p) => p.x === 3 && p.y === 3)).toBe(true);
  });

  it("also leaves its near corner open", () => {
    expect(eight.some((p) => p.x === 6 && p.y === 6)).toBe(false);
  });
});
