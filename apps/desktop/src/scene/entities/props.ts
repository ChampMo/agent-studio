/**
 * What is on a cat's desk, and why it is a fact rather than decoration.
 *
 * The desk shows **the tool this agent is using right now**, and nothing
 * else. That is read off the log — an `agent.tool.start` whose `callId` has
 * not had its `agent.tool.end` (`sceneState.ts`) — so a desk with a satellite
 * dish on it is a desk where a web search is running at this moment. An idle
 * desk is bare, whatever its owner could do. It is the same fact the
 * transcript's pending spinner shows, drawn a second way.
 *
 * It used to show up to three of the tools the agent *carried*, off the
 * frozen roster. That was a fact too, and it made a different thing
 * checkable — the research team whose web tools sat on the leader, who is
 * never assigned a task, showed as a dish on the desk nobody worked at. The
 * artist asked for the desk to show use rather than possession, so that
 * check now lives in the members panel, which lists what everyone carries,
 * and in the validator's `leader_only_tool`, which says it in words.
 *
 * **One drawing per group of tools, not per tool.** `read_file`, `glob`,
 * `grep` and `list_dir` are all "looking at the workspace" and are all the
 * computer; a different picture for each would be four things to draw that
 * say one thing. `send_message` deliberately has no drawing: it is the one
 * tool everybody has, and a desk that shows it shows nothing.
 *
 * A tool this build has never heard of shows nothing rather than a guess —
 * the same rule as an unknown status falling back to the default pose (§8).
 */
import type { Graphics } from "pixi.js";

import { TILE_H } from "../engine/iso";
import type { RoomColours } from "./room";

export type Prop =
  "toolbox" | "dish" | "phone" | "papers" | "computer" | "files";

/** Which tools are drawn as which thing. The folder names under `art/tools`. */
const GROUPS: { prop: Prop; tools: string[] }[] = [
  { prop: "toolbox", tools: ["bash"] },
  { prop: "dish", tools: ["web_search", "web_fetch"] },
  { prop: "phone", tools: ["ask_user"] },
  { prop: "papers", tools: ["write_file", "edit_file"] },
  { prop: "computer", tools: ["read_file", "glob", "grep", "list_dir"] },
  { prop: "files", tools: ["remember", "recall"] },
];

/** The drawing for a tool, or null for a tool that has none. */
export function propFor(tool: string | null | undefined): Prop | null {
  if (!tool) return null;
  return GROUPS.find((group) => group.tools.includes(tool))?.prop ?? null;
}

/**
 * Where the tool sits on the desk, in the actor's own space: the middle of
 * the desk top, its base on the near half. The cat sits at the far edge and
 * is drawn over it, so a tall tool tucks under the chin rather than covering
 * the face. The caption and task words hang below the desk for the same
 * reason.
 */
export const PROP_AT = { x: 0, y: TILE_H * 2.1 };

/**
 * The fallback when a tool's drawings have not arrived: a primitive at the
 * same spot, in theme colours. Drawn on every redraw rather than once, since
 * the colours come from the theme.
 */
export function drawProp(g: Graphics, prop: Prop, paint: RoomColours): void {
  const x = 0;
  const y = 0;

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
