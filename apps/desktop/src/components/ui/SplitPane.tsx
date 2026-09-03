/**
 * A draggable divider between the scene and what is under it (§17.1).
 *
 * The requirement that shapes this file is not the dragging. It is that a
 * divider you can only drag is a control that people who do not use a mouse
 * cannot use at all (WCAG 2.1.1). So the keyboard is not an accessibility
 * afterthought bolted onto a mouse widget — arrows, PageUp/PageDown, Home, End
 * and Enter all move the same one number, and the pointer is a second way in.
 *
 * Two sizes worth knowing apart: the **hit area** is 24px, because a 1px line
 * is not something anyone can reliably hit (WCAG 2.5.8), while the **line** is
 * as thin as it looks. The hit area is padding around the line, not the line
 * grown fat.
 *
 * The height is remembered per person, not per mission (§17.1). How tall you
 * like the scene is a fact about you; it should not reset because you opened a
 * different run.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { isCollapsed, nextHeight, readStoredHeight, snap } from "./splitter";

const STORAGE_KEY = "agent-studio.scene-height";

export interface SplitPaneProps {
  /** Drawn above the divider. Its height is what the divider controls. */
  top: React.ReactNode;
  bottom: React.ReactNode;
  /** Height in px the double-click and first run start from. */
  defaultHeight?: number;
  minHeight?: number;
  /** Cap, in px. Also capped at the container so the bottom never vanishes. */
  maxHeight?: number;
  label: string;
  /** Shown on hover and read out on focus, instead of printed under the pane
   *  for ever. Instructions belong to the control they describe. */
  hint?: string;
  /** Told the current height whenever it changes, including while dragging —
   *  the scene uses it to stop its ticker at zero rather than draw unseen. */
  onHeightChange?: (height: number) => void;
}

function remembered(fallback: number): number {
  try {
    return readStoredHeight(localStorage.getItem(STORAGE_KEY), fallback);
  } catch {
    // Private browsing, or storage denied. A preference that cannot be saved
    // is not a reason to fail.
    return fallback;
  }
}

function remember(height: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(height)));
  } catch {
    /* nothing to do, and nothing worth telling the user */
  }
}

export function SplitPane({
  top,
  bottom,
  defaultHeight = 280,
  minHeight = 0,
  maxHeight,
  label,
  hint,
  onHeightChange,
}: SplitPaneProps) {
  const frame = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  // What the person asked for, kept apart from what the window can currently
  // give. Storing only the second meant a transient measurement — a tab switch
  // mid-layout, a window being dragged — permanently destroyed the choice.
  const [desired, setDesired] = useState(() => remembered(defaultHeight));
  const [available, setAvailable] = useState<number>(Infinity);
  const [dragging, setDragging] = useState(false);
  /** What to go back to when Enter un-collapses. */
  const restoreTo = useRef(defaultHeight);

  // The real ceiling is whatever the container can spare, so the bottom pane
  // never disappears — including when the window is resized under a divider
  // that was already at its old maximum.
  const ceiling = Math.max(minHeight, Math.min(maxHeight ?? Infinity, available));

  // What is actually rendered: the wish, inside the room available.
  const height = Math.max(minHeight, Math.min(desired, ceiling));

  const setHeight = useCallback(
    (next: number, { persist = true }: { persist?: boolean } = {}) => {
      const wanted = Math.max(minHeight, next);
      setDesired(wanted);
      if (persist) remember(wanted);
    },
    [minHeight],
  );

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    // ResizeObserver rather than a resize listener: this pane changes size when
    // panels around it change too, not only when the window does (§17.1).
    const observer = new ResizeObserver(([entry]) => {
      // A height of zero is the observation that arrives before the browser
      // has laid anything out. Taking it at face value collapsed the pane —
      // and, because the clamp used to persist, saved that collapse for good.
      const box = entry?.contentRect.height ?? 0;
      if (box > 0) setAvailable(box - 120);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // One place tells the outside what the height is, and it is the rendered
  // one — the scene stops its ticker on this number, so it has to be the
  // number that is actually on screen (§17.1).
  useEffect(() => {
    onHeightChange?.(height);
  }, [height, onHeightChange]);

  const collapsed = isCollapsed(height);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const asked = nextHeight(event.key, {
      height,
      min: minHeight,
      max: ceiling,
      restore: restoreTo.current || defaultHeight,
    });
    if (asked === null) return;
    event.preventDefault();
    // Remember where we were before shutting, so Enter can put it back.
    if (!isCollapsed(height) && isCollapsed(asked)) restoreTo.current = height;
    setHeight(asked);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const box = frame.current?.getBoundingClientRect();
      if (!box) return;
      // Not persisted on every pointer move: writing to localStorage sixty
      // times a second is work nobody asked for. The pointerup below saves it.
      setHeight(event.clientY - box.top, { persist: false });
    };
    const stop = () => {
      setDragging(false);
      // Snap only when the drag ends. A keyboard step must land exactly where
      // it was aimed, so `nextHeight` never snaps.
      setHeight(snap(height, { min: minHeight, max: ceiling }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, height, setHeight]);

  return (
    <div ref={frame} className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 shrink-0 overflow-hidden"
        style={{ height: `${height}px` }}
        // Told to assistive technology as well as painted: a region with no
        // height is not "small", it is not there.
        aria-hidden={collapsed || undefined}
      >
        {top}
      </div>

      <div
        ref={handle}
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        aria-description={hint}
        title={hint}
        aria-valuenow={Math.round(height)}
        aria-valuemin={minHeight}
        aria-valuemax={Number.isFinite(ceiling) ? Math.round(ceiling) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setHeight(defaultHeight)}
        // 24px of hit area (WCAG 2.5.8) around a 1px line. The padding is what
        // is grabbable; the line is only what is seen.
        className={cn(
          "group relative flex h-6 shrink-0 cursor-row-resize items-center",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-focus)]",
        )}
      >
        <div
          className={cn(
            "h-px w-full transition-colors",
            dragging ? "bg-accent" : "bg-line group-hover:bg-line-strong",
            "group-focus-visible:bg-accent",
          )}
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-1/2 h-1 w-10 -translate-x-1/2 rounded-full",
            dragging ? "bg-accent" : "bg-line-strong/60 group-hover:bg-line-strong",
          )}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{bottom}</div>
    </div>
  );
}
