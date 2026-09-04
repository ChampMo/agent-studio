/**
 * Loading the cat sheet, in the shape Aseprite exports it.
 *
 * Two decisions here, and both exist so the art can be replaced without any
 * code changing.
 *
 * **Aseprite's `frameTags`, not Pixi's `animations`.** Pixi reads a spritesheet
 * JSON that lists animations as `{walk: ["walk0", "walk1"]}`. Aseprite does not
 * write that key — it writes `meta.frameTags`, a list of index ranges. So this
 * converts one to the other, which means `File > Export Sprite Sheet > JSON
 * Data` drops straight in with nothing to post-process. The placeholder
 * generator writes the same shape for the same reason.
 *
 * **`nearest`, always.** Pixel art scaled with the default filter turns to
 * porridge, and it is the kind of wrong that looks like a bad drawing rather
 * than a bad setting.
 *
 * A sheet that fails to load is not fatal: `ready` stays false, the scene draws
 * nothing where the cats would be, and the rest of the app — which is where
 * every fact actually lives — carries on. A missing texture must not take the
 * timeline down with it.
 */
import { Assets, Spritesheet, Texture } from "pixi.js";

const URL = "/sprites/cats.json";

interface AsepriteTag {
  name: string;
  from: number;
  to: number;
  direction?: string;
}

let sheet: Spritesheet | null = null;
let loading: Promise<Spritesheet | null> | null = null;

/** Frame names in sheet order — `frameTags` indexes into this. */
function ordered(data: { frames: Record<string, unknown> }): string[] {
  return Object.keys(data.frames);
}

export async function loadCats(): Promise<Spritesheet | null> {
  if (sheet) return sheet;
  if (loading) return loading;

  loading = (async () => {
    try {
      // `fetch`, not `Assets.load`. Pixi recognises spritesheet-shaped JSON and
      // hands back an already-parsed `Spritesheet` — at which point `data.frames`
      // is undefined, this threw, and the catch below turned a working sheet
      // into "no art" with nothing on the console to say why. The scene was
      // black for exactly that reason.
      const data = (await fetch(URL).then((r) => r.json())) as {
        frames: Record<string, unknown>;
        meta: { image: string; frameTags?: AsepriteTag[] };
      };

      // Aseprite writes `meta.frameTags`, a list of index ranges. Pixi looks
      // for `animations`, a map of names to frame names. This is the whole
      // adapter, and it is why an Aseprite export drops in unmodified.
      const names = ordered(data);
      const animations: Record<string, string[]> = {};
      for (const tag of data.meta.frameTags ?? []) {
        animations[tag.name] = names.slice(tag.from, tag.to + 1);
      }

      const texture = await Assets.load<Texture>(
        URL.replace(/[^/]+$/, data.meta.image),
      );
      texture.source.scaleMode = "nearest";

      const built = new Spritesheet(texture, {
        frames: data.frames,
        meta: data.meta,
        animations,
      } as never);
      await built.parse();
      sheet = built;
      return built;
    } catch {
      // Said by absence rather than by a crash — see the module comment.
      return null;
    }
  })();

  return loading;
}

/** The loaded sheet, or null while it is still coming. */
export function cats(): Spritesheet | null {
  return sheet;
}

/**
 * The frames for one layer and one pose.
 *
 * Falls back to `idle`, then to whatever the layer has, so a pose this build
 * has no art for still draws the cat rather than nothing (§8) — the same rule
 * `poseFor` follows on the data side.
 */
export function framesFor(layer: string, pose: string): Texture[] | null {
  const s = sheet;
  if (!s) return null;
  return (
    s.animations[`${layer}.${pose}`] ?? s.animations[`${layer}.idle`] ?? null
  );
}
