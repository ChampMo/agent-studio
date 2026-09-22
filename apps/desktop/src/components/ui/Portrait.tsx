/**
 * An agent's face, small enough to sit beside what they said (§11, §18.3).
 *
 * **Drawn artwork when there is some, the sprite composite when there is not.**
 * A cat is four layers on one canvas — face, eyes, mouth, collar — and
 * `catArt.ts` says which files. It is the same answer the scene gets, so the
 * cat at the desk and the cat in the transcript cannot be composed from
 * different drawings (§2.1).
 *
 * **Nothing here moves.** The eyes and the mouth each have two frames and this
 * component draws only the resting one. A still portrait claims nothing, which
 * is the point: a mouth that moves is the screen saying *this agent is
 * speaking*, and a portrait appears beside old transcript rows and in the
 * avatar picker, where nobody is speaking at all. The room animates because
 * the room is showing the present; a list is not.
 *
 * It is also the only workable option. `AvatarPicker` renders one of these per
 * option — nineteen swatches plus a 128px preview, four `<img>` each — and
 * blinking eighty elements would be churn in exchange for no information.
 *
 * Which of the two is used is decided by **asking the browser for the files**,
 * once for the whole window. Not by a manifest listing what has been drawn: a
 * list of filenames is a second place for the truth to live, and the one that
 * goes stale is the list rather than the folder. A cat drawn tomorrow needs no
 * code, and one that has not been drawn yet shows the cat we can still
 * assemble instead of a broken image.
 *
 * Everything below is the fallback path, unchanged and still exercised — a
 * frozen `roster_snapshot` names slots this catalogue no longer has, and it
 * still has to draw as somebody (§5.1, §8).
 *
 * Drawn from the **same sprite sheet and the same `lookFor` table the scene
 * uses**, so a cat in the room and the same cat in the transcript cannot end up
 * looking like two different people. If they ever disagree, one of them is
 * lying — the §2.1 argument, applied to a portrait.
 *
 * It draws through a canvas rather than CSS. A `mask-image` would have been
 * less code and would have thrown away the shading, since a mask keeps only
 * alpha — and a flat portrait beside a shaded cat is exactly the disagreement
 * this component exists to prevent. So it composites the three layers the same
 * way the scene does: multiply for the tint, `destination-in` to put the
 * sprite's own alpha back.
 *
 * Frame coordinates come from the atlas by **name**, never by arithmetic on a
 * row index. The sheet's own JSON is then the only place that knows where
 * anything is, which is what lets Aseprite re-export it in a different order
 * without silently drawing the wrong cat.
 *
 * Values this build does not know — an asset added by a newer version, or the
 * human catalogue frozen into an old mission's roster — fall back to the first
 * entry in each table (§8), and a missing sheet falls back to initials.
 */
import { useEffect, useRef, useState } from "react";

import {
  artFor,
  artReady,
  loadArt,
  restingLayers,
} from "../../scene/entities/catArt";
import { lookFor } from "../../scene/entities/palette";
import { roomColours } from "../../scene/entities/room";
import { useThemeStore } from "../../stores/themeStore";

interface Atlas {
  frames: Record<
    string,
    { frame: { x: number; y: number; w: number; h: number } }
  >;
}

//: Loaded once for the whole window. Both the image and the atlas, because a
//: frame is a rectangle in one described by the other.
let atlas: Atlas | null = null;
let image: HTMLImageElement | null = null;
let loading: Promise<boolean> | null = null;

function load(): Promise<boolean> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const [json, img] = await Promise.all([
        fetch("/sprites/cats.json").then((r) => r.json() as Promise<Atlas>),
        new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = "/sprites/cats.png";
        }),
      ]);
      atlas = json;
      image = img;
      return true;
    } catch {
      return false;
    }
  })();
  return loading;
}

/** The pose the portrait uses: standing, facing the room, first frame. */
const POSE = "idle.0";
//: How much of the 40px cell is head. The rest is body, which a portrait at
//: this size cannot show usefully.
const HEAD_H = 22;

function tinted(
  source: HTMLImageElement,
  rect: { x: number; y: number; w: number; h: number },
  colour: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = rect.w;
  c.height = HEAD_H;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(source, rect.x, rect.y, rect.w, HEAD_H, 0, 0, rect.w, HEAD_H);
  // Multiply keeps the greys' shading proportional to the tint, which is why
  // the sheet is drawn in white and grey and holds no colour of its own.
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `#${colour.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, rect.w, HEAD_H);
  // Multiply painted over the transparent pixels too; this puts the sprite's
  // own silhouette back.
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(source, rect.x, rect.y, rect.w, HEAD_H, 0, 0, rect.w, HEAD_H);
  return c;
}

export function Portrait({
  avatar,
  name,
  size = 32,
}: {
  avatar: Record<string, string> | null;
  /** Used for the accessible name and for the initials fallback. */
  name: string;
  size?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(atlas !== null);
  const [asked, setAsked] = useState(artReady());
  // Redrawn when the theme changes: the fur colours are read out of the
  // stylesheet, so a portrait that never re-ran would keep the previous
  // theme's cat beside a scene showing this one's — which is the exact
  // disagreement this component exists to prevent.
  const theme = useThemeStore((s) => s.choice);

  useEffect(() => {
    let alive = true;
    void load().then((ok) => alive && ok && setReady(true));
    void loadArt().then(() => alive && setAsked(true));
    return () => {
      alive = false;
    };
  }, []);

  const look = avatar ? lookFor(avatar) : null;
  // Until the files have answered it is not known whether this cat has been
  // drawn. Compositing the fallback in the meantime would mean visibly
  // replacing it a moment later with a different cat.
  const art =
    look && asked
      ? artFor(look.keys)
      : null;
  const painted = art?.face ?? null;

  useEffect(() => {
    const el = canvas.current;
    if (painted || !ready || !el || !avatar || !atlas || !image) return;
    const look = lookFor(avatar);
    const paint = roomColours();
    // The same rule the scene follows: from the stylesheet where the theme
    // names this fur, from the table where it does not.
    const fur = look.breed.token ? paint[look.breed.token] : look.breed.fur;
    const rows: { name: string; tint: number }[] = [
      { name: `base.${POSE}`, tint: fur },
      { name: `breed.${look.breed.layer}.${POSE}`, tint: look.breed.marking },
      // No accessory row: the hats and the glasses are drawn artwork only, so
      // a cat composited from the sheet wears none rather than one improvised
      // from a row meant for the old `prop` slot (§8). Same as the collar.
    ];

    const ctx = el.getContext("2d")!;
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.imageSmoothingEnabled = false;
    // `size` is a width, and this drew every cat at the full width of the
    // canvas — so the slot had never once shown here. A skinny cat and a
    // chonky one were the same picture in the rail, the transcript and every
    // roster card, which is a control that claims to do something and does
    // not (§1.1).
    const w = el.width * look.size.w;
    const h = el.height * look.size.h;
    const x = (el.width - w) / 2;
    // Anchored at the bottom, so a rounder cat spreads sideways from the same
    // chin line rather than floating.
    const y = el.height - h;
    for (const row of rows) {
      const cell = atlas.frames[row.name];
      if (!cell) continue;
      ctx.drawImage(tinted(image, cell.frame, row.tint), x, y, w, h);
    }
  }, [painted, ready, avatar, size, theme]);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

  if (look && art?.face) {
    // The size is in the artwork when it was drawn for this size, and in a
    // squash when it was not — never both, which would make the same cat fat
    // twice.
    const squash = art.scaled
      ? `scale(${look.size.w}, ${look.size.h})`
      : undefined;
    return (
      <span
        role="img"
        aria-label={name}
        style={{ width: size, height: size }}
        className="relative block shrink-0 overflow-hidden rounded-full bg-solid-2"
      >
        {restingLayers(art).map((src, index) => (
          <img
            key={src}
            src={src}
            alt=""
            aria-hidden="true"
            // Absolute, so a prop and a collar land on the body rather than
            // beside it. Every drawing shares one canvas and one origin, which
            // makes an overlay a matter of where it sits in the file rather
            // than of arithmetic here — and the body is the first child, so
            // the paint order is the file order.
            className="absolute inset-0 h-full w-full object-contain"
            style={{
              // The overlays sit on the body as drawn, so they take the same
              // squash or none of it.
              transform: squash,
              transformOrigin: "bottom center",
            }}
            // The body is what a slow connection should get first.
            loading={index === 0 ? "eager" : "lazy"}
          />
        ))}
      </span>
    );
  }

  // No avatar at all — a speaker who is not in the roster. Initials, rather
  // than a generic cat that would imply we know something about them.
  if (!avatar || !asked || !ready) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: size * 0.36 }}
        className="flex shrink-0 items-center justify-center rounded-full bg-solid-2 font-medium text-muted"
      >
        {initials || "?"}
      </span>
    );
  }

  return (
    <canvas
      ref={canvas}
      // The backing store is the sprite's own pixels; CSS scales it up whole.
      width={32}
      height={HEAD_H}
      role="img"
      aria-label={name}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        imageRendering: "pixelated",
      }}
      className="shrink-0 rounded-full bg-solid-2"
    />
  );
}
