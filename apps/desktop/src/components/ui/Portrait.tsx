/**
 * An agent's face, small enough to sit beside what they said (§11, §18.3).
 *
 * Drawn from the same `avatar_config` and the same `lookFor` table the scene
 * uses, so a character in the room and the same character in the transcript
 * cannot end up looking like two different people. If they ever disagree, one
 * of them is lying — the §2.1 argument, applied to a portrait.
 *
 * It is a silhouette, not a likeness: a head, hair with the right shape, and
 * the collar of the outfit, in that palette. That is all `avatar_config`
 * actually says, and drawing more than the data supports would be inventing a
 * face for an agent that has none (§1.1).
 *
 * Values this build does not know — an asset added by a newer version — fall
 * back to the first entry in each table rather than to `undefined`, the same
 * §8 rule the rest of the frontend follows.
 */
import { lookFor } from "../../scene/entities/palette";

function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, "0")}`;
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
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

  // No avatar at all — an agent that predates the catalogue, or a speaker who
  // is not in the roster. Initials, rather than a generic face that would
  // imply we know something about them.
  if (!avatar) {
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

  const look = lookFor(avatar);
  const skin = hex(look.palette.skin);
  const hair = hex(look.palette.hair);
  const cloth = hex(look.palette.cloth);
  const trim = hex(look.palette.trim);

  // One 40×40 box, head centred, shoulders running off the bottom edge — the
  // framing of a portrait rather than a figure standing in a circle.
  const headR = 11 * (look.body.w * 0.35 + 0.72);
  const headY = 17;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={name}
      className="shrink-0 rounded-full"
    >
      <circle cx="20" cy="20" r="20" fill={cloth} opacity="0.22" />
      <clipPath id={`portrait-${initials}-${look.palette.skin}`}>
        <circle cx="20" cy="20" r="20" />
      </clipPath>
      <g clipPath={`url(#portrait-${initials}-${look.palette.skin})`}>
        {/* Shoulders, and the collar if the outfit has one. */}
        <ellipse cx="20" cy="44" rx={13 * look.body.w} ry="13" fill={cloth} />
        {look.outfit.collar ? (
          <path
            d={`M ${20 - 7 * look.body.w} 34 L 20 40 L ${20 + 7 * look.body.w} 34`}
            fill="none"
            stroke={trim}
            strokeWidth="2"
          />
        ) : null}

        {/* Hair behind the head: how far down the sides it falls is the slot. */}
        {look.hair.side > 0.01 ? (
          <ellipse
            cx="20"
            cy={headY + 2}
            rx={headR + 2.5}
            ry={headR + look.hair.side * 14}
            fill={look.hair.hood ? cloth : hair}
          />
        ) : null}

        <circle cx="20" cy={headY} r={headR} fill={skin} />

        {/* And in front: the fringe, as tall as the slot says. */}
        {look.hair.top > 0.01 ? (
          <path
            d={`M ${20 - headR} ${headY} a ${headR} ${headR} 0 0 1 ${headR * 2} 0
                l 0 ${-look.hair.top * 5} a ${headR} ${headR} 0 0 0 ${-headR * 2} 0 z`}
            fill={look.hair.hood ? cloth : hair}
          />
        ) : null}
        {look.hair.tail ? (
          <circle cx={20 + headR} cy={headY + 3} r="3.4" fill={hair} />
        ) : null}
      </g>
    </svg>
  );
}
