/**
 * A button that opens a short list of actions (§18.3).
 *
 * Built because two places need the same thing: the composer's `+`, and the
 * `⋯` that is about to replace seven buttons on every roster card. Secondary
 * actions belong in a menu; what stays on the surface is the one thing you came
 * to do.
 *
 * The keyboard is not an afterthought here. A menu you can only reach with a
 * mouse is a menu some people cannot use at all, so:
 *
 * - the trigger opens on click, Enter, Space, or Down;
 * - Down and Up move through the items and wrap;
 * - Home and End jump to the ends;
 * - Escape closes and **returns focus to the trigger**, which is the part
 *   people notice when it is missing — focus left on a vanished element sends
 *   the next Tab to the top of the document;
 * - a click anywhere else closes it, and so does focus leaving entirely.
 *
 * `aria-label` on the trigger is required rather than optional, because the
 * whole point of the roster case is that seven identical `⋯` buttons need seven
 * different names.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Left of the label. Decorative — the label carries the meaning. */
  icon?: React.ReactNode;
  /** How loudly the row speaks.
   *
   *  `danger` (red) is for something irreversible. `warn` (amber) is for a
   *  choice worth thinking about that destroys nothing — "never ask" removes a
   *  safety gate, but choosing it does not break anything by itself, and
   *  painting it the same red as "delete for ever" spends the alarm colour on
   *  a setting. */
  tone?: "danger" | "warn";
  disabled?: boolean;
  /** Shown under the label, greyed. Use it to say *why* something is disabled
   *  rather than leaving a dead row with no explanation. */
  hint?: string;
}

/**
 * The box a floating panel has to stay inside.
 *
 * The nearest ancestor that clips, because that is what actually cuts the panel
 * off — the window is no help when the thing doing the cutting is a column with
 * `overflow-hidden` three levels up.
 */
function clipBounds(node: HTMLElement): { left: number; right: number } {
  let parent = node.parentElement;
  while (parent && parent !== document.body) {
    const style = getComputedStyle(parent);
    if (style.overflow !== "visible" || style.overflowX !== "visible") {
      const box = parent.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }
    parent = parent.parentElement;
  }
  return { left: 0, right: window.innerWidth };
}

export function Menu({
  label,
  items,
  trigger,
  align = "end",
  className,
  triggerClassName,
  selectedLabel,
}: {
  /** The trigger's accessible name. Include the thing it acts on — "More for
   *  Mara", not "More" — or a screen reader hears the same name N times. */
  label: string;
  items: MenuItem[];
  trigger: React.ReactNode;
  align?: "start" | "end";
  className?: string;
  /** Replaces the default square box. For a trigger that is a word rather than
   *  an icon, and should not look like a control until you reach for it. */
  triggerClassName?: string;
  /** Marked in the list, for a menu that is a choice rather than a set of
   *  actions. A menu that changes a setting has to show which one is on. */
  selectedLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Which way the panel goes. Measured, not assumed — see the effect below. */
  const [dropUp, setDropUp] = useState(false);
  /** Same idea, sideways. See the effect below. */
  const [flipX, setFlipX] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const usable = items.filter((item) => !item.disabled);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    // The part people notice when it is missing.
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  /**
   * Open downward unless there is not room, then flip.
   *
   * This was hardcoded upward, which suited the one caller that existed — a
   * composer sitting on the bottom edge of the window. The first card near the
   * top of the roster then opened a menu that ran off the top of the screen
   * with its last item unreachable.
   *
   * `useLayoutEffect` rather than `useEffect`: the measurement happens after
   * the panel is in the DOM but before the browser paints, so the flip is
   * never visible as a jump.
   */
  useLayoutEffect(() => {
    if (!open) {
      setDropUp(false);
      return;
    }
    const box = panel.current?.getBoundingClientRect();
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!box || !anchor) return;
    const below = window.innerHeight - anchor.bottom;
    const above = anchor.top;
    // Only flip when down genuinely does not fit *and* up fits better, so a
    // menu taller than the whole viewport still opens the predictable way.
    setDropUp(below < box.height + 8 && above > below);
  }, [open]);

  /**
   * And the same measurement sideways, which the vertical one had missed.
   *
   * The composer's autonomy menu sits 16px from the left edge of `main`, and
   * `main` is `overflow-hidden`. Right-aligned — which is correct, it grows
   * leftward from its trigger — a 362px panel started at x=12 and everything
   * left of the column edge was simply cut off: two menu items visible as
   * slivers, mid-word.
   *
   * The bound is the nearest **clipping** ancestor, not the window. The panel
   * was well inside the viewport; it was `main` doing the cutting, and a
   * viewport check would have found nothing wrong.
   */
  useLayoutEffect(() => {
    if (!open) {
      setFlipX(false);
      return;
    }
    const box = panel.current?.getBoundingClientRect();
    if (!box || !panel.current) return;
    const bounds = clipBounds(panel.current);
    // Only flip when this side genuinely does not fit and the other one does,
    // so a panel wider than the space it has stays where it is put.
    if (align === "end" && box.left < bounds.left) {
      setFlipX(box.left + box.width <= bounds.right);
    } else if (align === "start" && box.right > bounds.right) {
      setFlipX(box.right - box.width >= bounds.left);
    } else {
      setFlipX(false);
    }
  }, [open, align]);

  const step = (delta: number) => {
    if (usable.length === 0) return;
    setActive((current) => {
      let next = current;
      for (let i = 0; i < items.length; i += 1) {
        next = (next + delta + items.length) % items.length;
        if (!items[next]?.disabled) return next;
      }
      return current;
    });
  };

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setActive(items.findIndex((item) => !item.disabled));
          setOpen((was) => !was);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(
              event.key === "ArrowDown"
                ? items.findIndex((item) => !item.disabled)
                : items.map((item) => !item.disabled).lastIndexOf(true),
            );
            setOpen(true);
          }
        }}
        className={cn(
          triggerClassName ??
            cn(
              "flex min-h-[24px] min-w-[24px] items-center justify-center rounded-card",
              "text-muted transition-colors hover:bg-solid hover:text-text",
            ),
          open && "bg-solid text-text",
        )}
      >
        {trigger}
      </button>

      {open ? (
        <div
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              step(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              step(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActive(items.findIndex((item) => !item.disabled));
            } else if (event.key === "End") {
              event.preventDefault();
              setActive(items.map((item) => !item.disabled).lastIndexOf(true));
            } else if (event.key === "Tab") {
              // Tabbing out is a decision to leave, not to pick something.
              setOpen(false);
            }
          }}
          ref={panel}
          className={cn(
            // Capped, or a long `hint` stretches the panel to whatever the
            // text wants — 362px here — and a menu that wide has nowhere to go
            // in a narrow column. Hints wrap instead.
            "absolute z-30 min-w-[13rem] max-w-[18rem] overflow-hidden rounded-card",
            "border border-line bg-solid-2 py-1 shadow-lg",
            dropUp ? "bottom-full mb-1" : "top-full mt-1",
            // `end` means the panel's end lines up with the trigger's, so it
            // grows leftward. These two were the wrong way round, which meant
            // every menu in the app opened rightward from its trigger — only
            // visible once one sat against the window edge and was cut in half
            // by it. `TeamsPanel` had been passing `align="start"` to cancel
            // it out.
            (align === "end") !== flipX ? "right-0" : "left-0",
          )}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role={selectedLabel === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={
                selectedLabel === undefined ? undefined : item.label === selectedLabel
              }
              disabled={item.disabled}
              tabIndex={index === active ? 0 : -1}
              onClick={() => {
                if (item.disabled) return;
                close(false);
                item.onSelect();
              }}
              className={cn(
                "flex w-full min-h-[36px] items-center gap-3 px-3 py-1 text-left text-sm",
                item.disabled
                  ? "cursor-not-allowed text-faint"
                  : item.tone === "danger"
                    ? "text-stop hover:bg-stop/10"
                    : item.tone === "warn"
                      ? "text-wait hover:bg-wait/10"
                      : "text-text hover:bg-solid",
              )}
            >
              {item.icon ? (
                <span aria-hidden="true" className="shrink-0">
                  {item.icon}
                </span>
              ) : selectedLabel !== undefined ? (
                // A tick column, so the chosen row is marked and the others
                // still line up with it.
                <span aria-hidden="true" className="w-3 shrink-0 text-accent">
                  {item.label === selectedLabel ? "✓" : ""}
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {/* Says why a row is dead, instead of leaving it dead and
                    unexplained.

                    It wraps, which the panel's `max-w` was added for and this
                    span then undid: `truncate` cut the reason off at the panel
                    edge, so the one row that had something to explain was the
                    one row you could not read. A label can truncate — it is a
                    name and the menu is short — but a hint that ends in an
                    ellipsis has failed at its only job. */}
                {item.hint ? (
                  <span className="block text-xs leading-snug text-faint">
                    {item.hint}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
