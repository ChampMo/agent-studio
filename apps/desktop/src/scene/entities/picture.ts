/**
 * The drawn cats, as textures the scene can put on a sprite.
 *
 * `catArt.ts` decides *which* files a cat is made of and whether they exist;
 * this is the Pixi-side half of turning those paths into something the stage
 * can draw. `Portrait.tsx` does the same job with an `HTMLImageElement`,
 * because a DOM image and a WebGL texture are genuinely two different objects
 * — what they share is `artFor()`, so there is one answer to *which drawings
 * is this cat made of* (§2.1).
 *
 * **Only drawings that answered are used, and from the element that answered.**
 * `catArt` has already asked for every file with a plain image request that
 * treats a 404 and a dev server's HTML fallback the same way; the texture is
 * made from that element rather than by asking for the URL again.
 */
import { Texture } from "pixi.js";

import { drawnPaths, imageFor, loadArt } from "./catArt";

const textures = new Map<string, Texture>();
let loading: Promise<void> | null = null;

function one(path: string): void {
  const image = imageFor(path);
  if (!image) return;
  // From the element the probe loaded, not from the URL again: one fetch, and
  // the texture is made of the same bytes the existence check saw
  // (`artFetch.ts` says why that distinction turned out to matter).
  const texture = Texture.from(image);
  // Same filtering as the sprite sheet. These are drawings rather than pixel
  // art, but a portrait disc is scaled by the camera at every zoom level and
  // the two must not be sampled differently — one crisp cat beside one soft
  // one reads as a rendering fault.
  texture.source.scaleMode = "nearest";
  textures.set(path, texture);
}

/** Ask `catArt` what exists, then load exactly that. */
export function loadPictures(): Promise<void> {
  if (loading) return loading;
  loading = loadArt().then(() => {
    for (const path of drawnPaths()) one(path);
  });
  return loading;
}

/** The texture for one path, or undefined when it is not one that loaded. */
export function textureFor(path: string): Texture | undefined {
  return textures.get(path);
}
