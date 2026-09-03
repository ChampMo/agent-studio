/**
 * A status, drawn as a shape (§18.3).
 *
 * Five states that differ only by hue are one state to anyone who cannot tell
 * the hues apart, so each has its own outline: a circle finished, a diamond
 * working, a triangle waiting on you, a square that stopped badly, and a hollow
 * ring for one you stopped yourself.
 *
 * The mark is decorative on its own — the word is always beside it in the
 * layouts that use this — so it is hidden from assistive technology unless a
 * caller has nothing else to give.
 */
import type { MissionLook } from "./status";

const TONE: Record<MissionLook["tone"], string> = {
  done: "var(--color-done)",
  search: "var(--color-search)",
  write: "var(--color-write)",
  wait: "var(--color-wait)",
  stop: "var(--color-stop)",
  idle: "var(--color-idle)",
};

export function StatusMark({
  look,
  size = 9,
  /** Set only when the shape is the only thing saying what the state is. */
  labelled = false,
}: {
  look: MissionLook;
  size?: number;
  labelled?: boolean;
}) {
  const colour = TONE[look.tone];
  const half = size / 2;

  const shape = () => {
    switch (look.shape) {
      case "circle":
        return <circle cx={half} cy={half} r={half} fill={colour} />;
      case "diamond":
        return (
          <rect
            x={half - half * 0.78}
            y={half - half * 0.78}
            width={half * 1.56}
            height={half * 1.56}
            fill={colour}
            transform={`rotate(45 ${half} ${half})`}
          />
        );
      case "triangle":
        return (
          <polygon points={`${half},0 ${size},${size} 0,${size}`} fill={colour} />
        );
      case "square":
        return <rect x={0} y={0} width={size} height={size} fill={colour} rx={1} />;
      case "ring":
      default:
        return (
          <circle
            cx={half}
            cy={half}
            r={half - 1}
            fill="none"
            stroke={colour}
            strokeWidth={1.5}
          />
        );
    }
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? look.label : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      {shape()}
    </svg>
  );
}
