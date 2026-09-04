/**
 * What is on a cat's desk, and why it is a fact rather than decoration.
 *
 * The props come from the tools the agent actually carries, read off the
 * mission's **frozen roster snapshot** — so a replay shows the desk as it was
 * equipped for that run, not as the agent is equipped today (§5.1).
 *
 * That makes the room checkable. This project shipped a research team that ran
 * to completion and answered from memory because `web_search` sat on the
 * leader, and a leader with workers is never assigned a task: every tool
 * present, on a real member, spelled correctly, and dead. With props on desks
 * you can *see* it — the satellite dish is on the desk nobody works at, and the
 * workers' desks have none.
 *
 * **Three slots, fixed priority.** Tester carries eleven tools, which is six
 * prop groups; a desk with six things on it says less than one showing the
 * three that set this cat apart from the cat next to it. The order is fixed
 * rather than computed from the team, so the same agent's desk looks the same
 * on every team they are on.
 *
 * `send_message` deliberately has no prop. Everyone has it, so drawing it
 * would take a slot to say nothing — the same reason six `tool_uncovered`
 * lines became one.
 *
 * What this is not: a claim of completeness. A desk shows at most three
 * groups, and the members panel is where the full list lives.
 */
import type { Graphics } from "pixi.js";

import { TILE_H, TILE_W } from "../engine/iso";
import type { RoomColours } from "./room";

export type Prop =
  "toolbox" | "dish" | "phone" | "papers" | "computer" | "files";

/** Most telling first. Roughly rarity and risk, which is the same order as
 *  "what would surprise you about this desk". */
const PRIORITY: { prop: Prop; tools: string[] }[] = [
  { prop: "toolbox", tools: ["bash"] },
  { prop: "dish", tools: ["web_search", "web_fetch"] },
  { prop: "phone", tools: ["ask_user"] },
  { prop: "papers", tools: ["write_file", "edit_file"] },
  { prop: "computer", tools: ["read_file", "glob", "grep", "list_dir"] },
  { prop: "files", tools: ["remember", "recall"] },
];

/** How many will fit on a desk before it stops reading as a desk. */
export const SLOTS = 3;

export function propsFor(tools: string[]): Prop[] {
  const held = new Set(tools);
  return PRIORITY.filter((entry) => entry.tools.some((t) => held.has(t)))
    .map((entry) => entry.prop)
    .slice(0, SLOTS);
}

/** Where each slot sits on the desk's diamond, left to right. */
const PLACES: { x: number; y: number }[] = [
  { x: -TILE_W * 0.42, y: TILE_H * 0.95 },
  { x: 0, y: TILE_H * 1.2 },
  { x: TILE_W * 0.42, y: TILE_H * 0.95 },
];

/**
 * Drawn as primitives rather than sprites, on purpose for now: they are small,
 * they never animate, and keeping them out of the sheet means the art can be
 * redrawn without re-registering every prop against a cell grid. When the real
 * sheet lands they become one more row and this function points at it.
 */
export function drawProp(
  g: Graphics,
  prop: Prop,
  slot: number,
  paint: RoomColours,
): void {
  const at = PLACES[slot];
  if (!at) return;
  const { x, y } = at;

  switch (prop) {
    case "computer":
      // A screen on a stand, facing the room.
      g.rect(x - 7, y - 12, 14, 10).fill({ color: paint.ink });
      g.rect(x - 5, y - 10, 10, 6).fill({ color: paint.screen });
      g.rect(x - 2, y - 2, 4, 2).fill({ color: paint.deskSide });
      break;
    case "papers":
      g.rect(x - 6, y - 4, 12, 4).fill({ color: paint.paper });
      g.rect(x - 4, y - 6, 12, 4).fill({ color: paint.paper });
      g.rect(x + 5, y - 9, 1, 7).fill({ color: paint.danger });
      break;
    case "toolbox":
      // `bash` is the dangerous one, and the only prop that says so in colour
      // — paired with its own shape, never colour alone (§18.3).
      g.rect(x - 7, y - 7, 14, 7).fill({ color: paint.danger });
      g.rect(x - 2, y - 10, 4, 3).fill({ color: paint.deskTop });
      break;
    case "phone":
      g.rect(x - 5, y - 4, 10, 4).fill({ color: paint.ink });
      g.rect(x - 6, y - 8, 12, 3).fill({ color: paint.ink });
      g.rect(x + 4, y - 8, 1, 5).fill({ color: paint.metal });
      break;
    case "dish":
      g.circle(x, y - 9, 5).fill({ color: paint.metal });
      g.rect(x - 1, y - 5, 2, 5).fill({ color: paint.metal });
      break;
    case "files":
      g.rect(x - 6, y - 11, 12, 11).fill({ color: paint.metal });
      g.rect(x - 4, y - 9, 8, 1).fill({ color: paint.paper });
      g.rect(x - 4, y - 5, 8, 1).fill({ color: paint.paper });
      break;
  }
}
