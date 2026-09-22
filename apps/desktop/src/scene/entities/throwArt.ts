/**
 * The things cats throw at each other, as textures.
 *
 * `throw/<moment>/<thing>.png` — one folder per moment on the log that sends
 * something across the room (`sceneState.ts` decides which events those
 * are), and a few drawings per moment so the same event does not always
 * throw the same thing. Which one is picked is decided by the event's seq,
 * so a replay throws exactly what the live run threw.
 *
 * A moment whose folder did not arrive throws nothing: the log still says
 * the task was assigned, and a missing picture is not a reason to invent a
 * shape for it.
 */
import { Texture } from "pixi.js";

import { fetchImage } from "./artFetch";

const THROW = "/art/throw";

export type ThrowKind = "request" | "assign" | "done" | "failed" | "message";

export const THINGS: Record<ThrowKind, string[]> = {
  request: ["bell", "paw"],
  assign: ["clipboard", "folder", "mouse", "scroll"],
  done: ["bird", "fish"],
  failed: ["fish-bone", "tin-empty"],
  message: ["note", "plane"],
};

export function throwPath(kind: ThrowKind, thing: string): string {
  return `${THROW}/${kind}/${thing}.png`;
}

const textures = new Map<string, Texture>();
let loading: Promise<void> | null = null;

async function one(path: string): Promise<void> {
  const image = await fetchImage(path);
  if (!image) return;
  const texture = Texture.from(image);
  texture.source.scaleMode = "nearest";
  textures.set(path, texture);
}

export function loadThrowArt(): Promise<void> {
  if (loading) return loading;
  const paths = (Object.keys(THINGS) as ThrowKind[]).flatMap((kind) =>
    THINGS[kind].map((thing) => throwPath(kind, thing)),
  );
  loading = Promise.all(paths.map(one)).then(() => undefined);
  return loading;
}

/**
 * The drawing to throw for this moment, chosen by seq among the ones that
 * loaded — or undefined when none did.
 */
export function throwTexture(kind: ThrowKind, seq: number): Texture | undefined {
  const loaded = THINGS[kind]
    .map((thing) => textures.get(throwPath(kind, thing)))
    .filter((t): t is Texture => t !== undefined);
  if (loaded.length === 0) return undefined;
  return loaded[Math.abs(seq) % loaded.length];
}
