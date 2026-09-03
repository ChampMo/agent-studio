/**
 * A checkbox that belongs to this app (§18.3).
 *
 * The native control is drawn by the operating system and cannot be restyled
 * past the odd accent colour — so on a dark screen every checkbox was a small
 * light-grey Windows square, the same mismatch the native `<select>` had.
 *
 * The input itself is kept and only *visually* hidden. That is the whole trick,
 * and the reason not to build this out of a `<div role="checkbox">`: the real
 * input keeps the label association, the tab order, the space-bar toggle, form
 * participation, and — the one people forget — the way assistive technology
 * announces state changes. What is replaced is the picture, not the control.
 *
 * `peer` styling drives the box from the input's own `:checked` and
 * `:focus-visible`, so the two can never disagree; there is no second copy of
 * "is it on" to keep in sync.
 *
 * The whole row is the label, so the text is a hit target too — a 16px square
 * is a hard thing to point at, and the words beside it are free (WCAG 2.5.8).
 */
import { useId } from "react";
import { cn } from "../../lib/cn";
import { CheckIcon } from "./icons";

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
  id,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: React.ReactNode;
  /** A second line under the label, for the consequence of ticking it. */
  hint?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const auto = useId();
  const inputId = id ?? auto;

  return (
    <label
      htmlFor={inputId}
      className={cn(
        "group flex min-h-[36px] items-start gap-2.5 py-1",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        // Visually hidden, not removed. `sr-only` keeps it focusable and
        // announced; `display:none` or `hidden` would take it out of the tab
        // order and out of the accessibility tree entirely.
        className="peer sr-only"
      />

      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px]",
          "border border-line-strong bg-solid transition-colors",
          // The tick is drawn in `currentColor` and the box is transparent
          // until checked. `peer-checked:` compiles to a sibling combinator,
          // so it cannot reach an element *inside* this span — driving the
          // colour from here is what makes the mark appear.
          "text-transparent",
          "peer-checked:border-accent peer-checked:bg-accent peer-checked:text-[#08222c]",
          // The input is `sr-only`, so its own focus ring would be invisible —
          // the box has to wear it instead.
          "peer-focus-visible:outline peer-focus-visible:outline-1",
          "peer-focus-visible:outline-offset-2",
          "peer-focus-visible:outline-[var(--color-focus)]",
          !disabled && "group-hover:border-accent",
        )}
      >
        <CheckIcon size={12} />
      </span>

      <span className="min-w-0">
        <span className="block text-sm text-text">{label}</span>
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}
