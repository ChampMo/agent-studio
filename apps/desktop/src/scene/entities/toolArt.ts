/**
 * The drawn tools, as frame sequences the desk can play.
 *
 * `tools/<prop>/<n>.png` — one folder per drawing in `props.ts`, played in
 * order and looped for as long as the tool runs. Two files are not frames:
 * `computer/monitor.png` stands still beside the case whose lights are the
 * animation, and `toolbox/wrench.png` is what floats up out of the open box.
 * `toolbox/shut.png` is loaded and not drawn — an idle desk is bare — so a
 * future that wants a shut box on it does not have to come back here.
 *
 * **A sequence is all or nothing**, the same rule the cat's mouth is under. A
 * loop with a frame missing would stutter, and a stutter reads as the app
 * being broken rather than the art being partial. A drawing with any frame
 * absent has no art here and the desk falls back to the primitive.
 *
 * Existence is asked, not declared, as with the cats: every path is requested
 * once at startup, and a texture is made from the element that answered.
 */
import { Texture } from "pixi.js";

import { fetchImage } from "./artFetch";
import type { Prop } from "./props";

const TOOLS = "/art/tools";

/** The frames of each loop, in the order they play. */
export const FRAMES: Record<Prop, string[]> = {
  computer: ["1", "2"],
  dish: ["1", "2", "3"],
  files: ["1", "2"],
  papers: ["1", "2", "3", "4"],
  phone: ["1", "2", "3"],
  toolbox: ["open"],
};

/** The pieces that are drawn alongside a loop rather than as part of it. */
export const EXTRAS = {
  monitor: "computer/monitor",
  wrench: "toolbox/wrench",
  shut: "toolbox/shut",
} as const;
export type Extra = keyof typeof EXTRAS;

export function framePaths(prop: Prop): string[] {
  return FRAMES[prop].map((n) => `${TOOLS}/${prop}/${n}.png`);
}

export function extraPath(extra: Extra): string {
  return `${TOOLS}/${EXTRAS[extra]}.png`;
}

const textures = new Map<string, Texture>();
let loading: Promise<void> | null = null;

async function one(path: string): Promise<void> {
  const image = await fetchImage(path);
  if (!image) return;
  const texture = Texture.from(image);
  // Pixel art on a desk that the camera scales: sampled like everything else.
  texture.source.scaleMode = "nearest";
  textures.set(path, texture);
}

/** Ask for every frame and extra. Resolves when all have answered. */
export function loadToolArt(): Promise<void> {
  if (loading) return loading;
  const paths = [
    ...(Object.keys(FRAMES) as Prop[]).flatMap(framePaths),
    ...(Object.keys(EXTRAS) as Extra[]).map(extraPath),
  ];
  loading = Promise.all(paths.map(one)).then(() => undefined);
  return loading;
}

/** Every frame of a drawing's loop, or none at all when any is missing. */
export function toolFrames(prop: Prop): Texture[] {
  const found = framePaths(prop).map((path) => textures.get(path));
  return found.every((t): t is Texture => t !== undefined) ? found : [];
}

/** A piece drawn beside a loop, or undefined when it did not arrive. */
export function toolExtra(extra: Extra): Texture | undefined {
  return textures.get(extraPath(extra));
}
