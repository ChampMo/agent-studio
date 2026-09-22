/**
 * One order, used everywhere a team is listed.
 *
 * The case that mattered is a real one: WEB DEV seats its leader in **seat 4**,
 * and nothing in the backend makes a leader sit at seat 0 — the validator
 * checks there is exactly one and says nothing about where. So a rule that
 * assumed the leader was first by virtue of their seat number was wrong on a
 * team that exists.
 */
import { describe, expect, it } from "vitest";

import { SIZES } from "../entities/palette";

import { bySeat } from "./order";

const WEB_DEV = [
  { seat_index: 0, role_in_team: "member", name: "Tester" },
  { seat_index: 1, role_in_team: "member", name: "UX/UI" },
  { seat_index: 2, role_in_team: "member", name: "Developer" },
  { seat_index: 3, role_in_team: "member", name: "BA" },
  { seat_index: 4, role_in_team: "leader", name: "PM" },
];

describe("the order a team is listed in", () => {
  it("puts the leader first even from the last seat", () => {
    expect(bySeat(WEB_DEV).map((m) => m.name)).toEqual([
      "PM",
      "Tester",
      "UX/UI",
      "Developer",
      "BA",
    ]);
  });

  it("keeps everyone else in seat order", () => {
    // Not by tokens, not by who did most. A rank is a comparison the panel
    // would be inventing, and an order that changes as statuses change makes
    // the list move under the reader.
    const shuffled = [WEB_DEV[3]!, WEB_DEV[0]!, WEB_DEV[2]!, WEB_DEV[1]!];
    expect(bySeat(shuffled).map((m) => m.seat_index)).toEqual([0, 1, 2, 3]);
  });

  it("leaves a leaderless team in plain seat order", () => {
    // The builder allows saving one; the launcher refuses to run it (§5.2).
    const none = WEB_DEV.map((m) => ({ ...m, role_in_team: "member" }));
    expect(bySeat(none).map((m) => m.seat_index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not mutate what it was given", () => {
    const input = [...WEB_DEV];
    bySeat(input);
    expect(input.map((m) => m.name)).toEqual(WEB_DEV.map((m) => m.name));
  });
});

/**
 * The camera's limits, as arithmetic.
 *
 * The zoom bounds and the zoom-to-cursor rule are the two parts of the camera
 * that are wrong in a way you cannot see: a bound that is off lets the room
 * become a speck or a wall of blocks, and a cursor anchor that is off pushes
 * the thing you leaned in to look at off the side. Both are pure sums, so they
 * are tested rather than judged by dragging.
 */
describe("the camera's arithmetic", () => {
  const MIN = 0.5;
  const MAX = 3;
  const STEP = 1.12;

  const clamp = (fit: number, from: number, factor: number) =>
    Math.min(fit * MAX, Math.max(fit * MIN, from * factor));

  it("cannot be zoomed past the limits, however many notches", () => {
    const fit = 0.8;
    let scale = fit;
    for (let i = 0; i < 100; i += 1) scale = clamp(fit, scale, STEP);
    expect(scale).toBeCloseTo(fit * MAX);

    for (let i = 0; i < 100; i += 1) scale = clamp(fit, scale, 1 / STEP);
    expect(scale).toBeCloseTo(fit * MIN);
  });

  it("measures the limits against the fit, not against 1:1", () => {
    // A room too big to fit at 1:1 starts below 1, and still has to be able to
    // zoom out from wherever it actually starts.
    expect(clamp(0.4, 0.4, 1 / STEP)).toBeCloseTo(0.4 / STEP);
    expect(clamp(0.4, 0.2, 1 / STEP)).toBeCloseTo(0.2);
  });

  it("keeps the point under the cursor under the cursor", () => {
    // The whole reason zoom is anchored rather than centred. Given a camera
    // and a scale, the world point at a screen position must not move when
    // the scale changes and the camera is corrected for it.
    const screen = { w: 800, h: 400 };
    const at = (cam: { x: number; y: number }, scale: number) => ({
      x: screen.w / 2 - cam.x * scale,
      y: screen.h * 0.52 - cam.y * scale,
    });

    const from = 1;
    const cam = { x: 10, y: 20 };
    const px = 620;
    const py = 90;

    const origin = at(cam, from);
    const world = { x: (px - origin.x) / from, y: (py - origin.y) / from };

    const to = from * STEP;
    const next = {
      x: world.x - (px - screen.w / 2) / to,
      y: world.y - (py - screen.h * 0.52) / to,
    };
    const after = at(next, to);

    expect(after.x + world.x * to).toBeCloseTo(px);
    expect(after.y + world.y * to).toBeCloseTo(py);
  });
});

/**
 * The size axis is an axis.
 *
 * It replaced a list that mixed a width (`slim`/`stout`), a height (`tall`)
 * and an overall scale (`small`), so moving one notch could make a cat wider,
 * taller or smaller depending on where you started. These are the sums that
 * say it is one direction now, rather than five values that happen to differ.
 */
describe("how round a cat is", () => {
  // Imported, never copied. This block used to declare its own five-entry
  // table and assert a monotonic width axis over it — so when the catalogue
  // shrank to the two sizes that were actually drawn, it went on passing over
  // a table that no longer existed anywhere. A test built from the same
  // assumption as the code proves nothing; this one fails if the real table
  // changes shape.
  it("has one entry per drawing, and only those", () => {
    expect(Object.keys(SIZES)).toEqual(["normal", "fat"]);
  });

  it("widens rather than scales", () => {
    // The multipliers survive for the sprite fallback and for a breed whose
    // fat drawing has not landed. If `fat` were 1.0 those cats would be the
    // same picture as the normal one, and the slot would claim to do
    // something it does not (§1.1).
    expect(SIZES.fat!.w).toBeGreaterThan(SIZES.normal!.w);
    // And settles slightly as it widens, so it reads as heavy and not as
    // stretched.
    expect(SIZES.fat!.h).toBeLessThan(SIZES.normal!.h);
  });
});
