/**
 * A dropdown that belongs to this app (§18.3).
 *
 * A native `<select>` cannot be styled past its border. The list it opens is
 * drawn by the operating system — system font, system metrics, a bright blue
 * highlight — so on a dark, muted screen every dropdown opened a window from a
 * different application. The trigger looked right and the part you actually
 * read did not.
 *
 * So this is the listbox pattern, drawn by us:
 *
 * - `role="combobox"` on the trigger with `aria-expanded` and `aria-controls`;
 * - `role="listbox"` on the panel, `role="option"` with `aria-selected` on each
 *   row, and `aria-activedescendant` pointing at the one being moved over;
 * - Up/Down move, Home/End jump, Enter and Space pick, Escape closes and
 *   returns focus to the trigger;
 * - typing jumps to the next option starting with those letters, which is the
 *   one native behaviour people genuinely rely on and the one most hand-rolled
 *   selects forget.
 *
 * It flips above the trigger only when there is no room below, measured rather
 * than assumed — the same rule as `Menu`, and for the same reason: hardcoding
 * a direction is right until the second caller.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { ChevronDownIcon } from "./icons";

export interface SelectOption {
  value: string;
  label: string;
  /** A second line, for what the label cannot say on its own. */
  hint?: string;
  disabled?: boolean;
}

export function Select({
  value,
  options,
  onChange,
  id,
  label,
  className,
  triggerClassName,
  placeholder,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Bound to a visible `<label htmlFor>` by the caller. */
  id?: string;
  /** Used when there is no visible label to point at. */
  label?: string;
  className?: string;
  triggerClassName?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const firstEnabled = () => options.findIndex((option) => !option.disabled);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };

  const pick = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Open on the current value, not the top: a list of eight where the seventh
  // is chosen should not make you scroll to see where you are.
  useEffect(() => {
    if (!open) return;
    const at = options.findIndex((option) => option.value === value);
    setActive(at >= 0 ? at : firstEnabled());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) rows.current[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Measured before paint, so the flip is never a visible jump.
  useLayoutEffect(() => {
    if (!open) {
      setDropUp(false);
      return;
    }
    const box = panel.current?.getBoundingClientRect();
    const anchor = trigger.current?.getBoundingClientRect();
    if (!box || !anchor) return;
    const below = window.innerHeight - anchor.bottom;
    setDropUp(below < box.height + 8 && anchor.top > below);
  }, [open]);

  const step = (delta: number) =>
    setActive((current) => {
      let next = current;
      for (let i = 0; i < options.length; i += 1) {
        next = (next + delta + options.length) % options.length;
        if (!options[next]?.disabled) return next;
      }
      return current;
    });

  /** Jump to the next option starting with what was typed. */
  const typeahead = (key: string) => {
    const now = Date.now();
    typed.current.text = now - typed.current.at > 700 ? key : typed.current.text + key;
    typed.current.at = now;
    const needle = typed.current.text.toLowerCase();
    const at = options.findIndex(
      (option) => !option.disabled && option.label.toLowerCase().startsWith(needle),
    );
    if (at >= 0) {
      setActive(at);
      if (!open) onChange(options[at]!.value);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else step(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      setActive(firstEnabled());
    } else if (event.key === "End" && open) {
      event.preventDefault();
      setActive(options.map((option) => !option.disabled).lastIndexOf(true));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) pick(active);
      else setOpen(true);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      typeahead(event.key);
    }
  };

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        aria-label={label}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        // Focuses like the inputs beside it rather than like a button: it is
        // a field to everyone looking at it. See index.css.
        data-field=""
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onKeyDown}
        className={cn(
          triggerClassName ??
            cn(
              "flex min-h-[36px] w-full items-center justify-between gap-2 rounded-card",
              "border border-line bg-solid px-3 text-sm text-text",
              "transition-colors hover:border-line-strong",
            ),
        )}
      >
        <span className={cn("min-w-0 truncate", !selected && "text-faint")}>
          {selected?.label ?? placeholder ?? ""}
        </span>
        {/* Decorative: the trigger already announces itself as a combobox. */}
        <ChevronDownIcon
          size={14}
          className={cn("shrink-0 text-faint transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          ref={panel}
          id={listId}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className={cn(
            "absolute left-0 right-0 z-30 max-h-64 overflow-y-auto rounded-card",
            "border border-line bg-solid-2 py-1 shadow-lg",
            dropUp ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {options.map((option, index) => {
            const chosen = option.value === value;
            return (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                ref={(node) => {
                  rows.current[index] = node;
                }}
                role="option"
                aria-selected={chosen}
                aria-disabled={option.disabled || undefined}
                onPointerDown={(event) => {
                  // Before the document listener above can close the panel.
                  event.preventDefault();
                  pick(index);
                }}
                onPointerEnter={() => !option.disabled && setActive(index)}
                className={cn(
                  "flex min-h-[36px] cursor-pointer items-center gap-2.5 px-3 text-sm",
                  option.disabled && "cursor-not-allowed text-faint",
                  !option.disabled && index === active && "bg-solid",
                  !option.disabled && "text-text",
                )}
              >
                {/* A tick column, so the chosen row is marked and the rest
                    still line up with it. */}
                <span aria-hidden="true" className="w-3 shrink-0 text-accent">
                  {chosen ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.hint ? (
                    <span className="block truncate text-xs text-faint">
                      {option.hint}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
