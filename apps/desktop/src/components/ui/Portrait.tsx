/**
 * An agent's face, small enough to sit beside what they said (§11, §18.3).
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
  // Redrawn when the theme changes: the fur colours are read out of the
  // stylesheet, so a portrait that never re-ran would keep the previous
  // theme's cat beside a scene showing this one's — which is the exact
  // disagreement this component exists to prevent.
  const theme = useThemeStore((s) => s.choice);

  useEffect(() => {
    let alive = true;
    void load().then((ok) => alive && ok && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!ready || !el || !avatar || !atlas || !image) return;
    const look = lookFor(avatar);
    const paint = roomColours();
    // The same rule the scene follows: from the stylesheet where the theme
    // names this fur, from the table where it does not.
    const fur = look.palette.token
      ? paint[look.palette.token]
      : look.palette.fur;
    const rows: { name: string; tint: number }[] = [
      { name: `base.${POSE}`, tint: fur },
      { name: `coat.${look.keys.coat}.${POSE}`, tint: look.palette.marking },
      { name: `outfit.${look.keys.outfit}.${POSE}`, tint: look.palette.cloth },
    ];

    const ctx = el.getContext("2d")!;
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.imageSmoothingEnabled = false;
    for (const row of rows) {
      const cell = atlas.frames[row.name];
      if (!cell) continue;
      ctx.drawImage(
        tinted(image, cell.frame, row.tint),
        0,
        0,
        el.width,
        el.height,
      );
    }
  }, [ready, avatar, size, theme]);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

  // No avatar at all — a speaker who is not in the roster. Initials, rather
  // than a generic cat that would imply we know something about them.
  if (!avatar || !ready) {
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
