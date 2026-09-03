/**
 * A vertical divider you can drag — and reach without a mouse (WCAG 2.1.1).
 *
 * The sibling of `SplitPane`, and it makes the same two commitments for the
 * same reasons:
 *
 * * **The keyboard is not an afterthought.** Arrows move it, Home and End go to
 *   the limits, and the whole thing is a `separator` with real `aria-value*`
 *   attributes — so a divider that only responds to dragging is not shipped.
 * * **The hit area is 24px, the line is 1px** (WCAG 2.5.8). The padding is what
 *   you grab; the line is only what you see. A 1px target is not something
 *   anyone can reliably hit.
 *
 * It reports deltas rather than owning a width. Where the number lives, what
 * clamps it and whether it is remembered are the caller's business — here it is
 * `panelStore`, which keeps one width per panel.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

const STEP = 16;
const BIG_STEP = 64;

export function ResizeHandle({
  width,
  min,
  max,
  onResize,
  label,
  hint,
}: {
  width: number;
  min: number;
  max: number;
  /** Called with the new width, already inside [min, max]. */
  onResize: (next: number) => void;
  label: string;
  hint?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      // The panel is on the right, so dragging left makes it wider — the delta
      // is subtracted, not added. Getting this backwards is the classic bug in
      // a right-hand resizer and it is invisible until you try it.
      const next = start.current.width - (event.clientX - start.current.x);
      onResize(Math.max(min, Math.min(max, next)));
    };
    const stop = () => setDragging(false);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, min, max, onResize]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-description={hint}
      title={hint}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(event) => {
        const by =
          event.key === "ArrowLeft"
            ? STEP
            : event.key === "ArrowRight"
              ? -STEP
              : event.key === "PageUp"
                ? BIG_STEP
                : event.key === "PageDown"
                  ? -BIG_STEP
                  : null;
        if (by !== null) {
          event.preventDefault();
          onResize(Math.max(min, Math.min(max, width + by)));
          return;
        }
        if (event.key === "Home") {
          event.preventDefault();
          onResize(max);
        } else if (event.key === "End") {
          event.preventDefault();
          onResize(min);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        start.current = { x: event.clientX, width };
        setDragging(true);
      }}
      // 24px of grabbable area around a 1px line, the same trade `SplitPane`
      // makes: the padding is the target, the line is the appearance.
      className={cn(
        "group relative w-6 shrink-0 cursor-col-resize",
        "-mx-3 z-10 flex items-stretch justify-center",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-px transition-colors",
          dragging ? "bg-accent" : "bg-transparent group-hover:bg-line-strong",
          "group-focus-visible:bg-accent",
        )}
      />
    </div>
  );
}
