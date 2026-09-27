/**
 * The handful of primitives M1 needs, in shadcn/ui's shape so real shadcn
 * components can be added on top later without a restyle.
 *
 * Deliberately plain: the RPG look belongs to M5+, and building it now would be
 * touching the graphics layer early (PROJECT_BRIEF.md §2.9).
 */
import { useId } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "../../lib/cn";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
        "transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" &&
          "bg-accent text-[#08222c] hover:brightness-110",
        variant === "secondary" &&
          "border border-line bg-solid-2 text-text hover:bg-solid-2",
        variant === "danger" && "bg-stop text-[#08222c] hover:brightness-110",
        variant === "ghost" && "text-muted hover:bg-solid-2",
        className,
      )}
    />
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "w-full rounded-md border border-line bg-solid px-3 py-2 text-sm",
        "text-text placeholder:text-faint",
        "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-text">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

/**
 * A heading over a *group* of controls, which `Field` must not be used for.
 *
 * `Field` renders a `<label>`, and a label may not contain another label.
 * `ToolPicker` had thirteen `Checkbox` rows (each its own `<label>`) inside
 * one, and React builds the tree through the DOM API, so the parser never
 * auto-closes it the way it would in hand-written HTML: the invalid nesting
 * really existed. Measured in the running app - clicking the word "Tools"
 * toggled `read_file`, because a label with no `htmlFor` activates its first
 * labelable descendant. A heading that silently grants a tool.
 *
 * It was wrong for a screen reader too: with no `htmlFor`, "Tools" was folded
 * into the first checkbox's accessible name instead of naming the set. This
 * says what it actually is.
 */
export function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="block space-y-1.5">
      <span id={id} className="text-sm font-medium text-text">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  return (
    <span
      className={cn(
        // `max-w-full truncate`: one long trait used to make the row wider
        // than the card rather than wrapping or cutting.
        "inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5",
        "text-[11px] font-medium",
        tone === "neutral" && "bg-solid-2 text-muted",
        tone === "good" && "bg-done/15 text-done",
        tone === "bad" && "bg-stop/15 text-stop",
        tone === "warn" && "bg-attn-soft text-attn",
      )}
    >
      {children}
    </span>
  );
}
