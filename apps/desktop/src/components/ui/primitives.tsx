/**
 * The handful of primitives M1 needs, in shadcn/ui's shape so real shadcn
 * components can be added on top later without a restyle.
 *
 * Deliberately plain: the RPG look belongs to M5+, and building it now would be
 * touching the graphics layer early (PROJECT_BRIEF.md §2.9).
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({ className, variant = "primary", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
        "transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-sky-600 text-white hover:bg-sky-500",
        variant === "secondary" &&
          "border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-500",
        variant === "ghost" && "text-slate-300 hover:bg-slate-800",
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm",
        "text-slate-100 placeholder:text-slate-500",
        "focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500",
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
      <span className="text-sm font-medium text-slate-200">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-slate-400">{hint}</span> : null}
    </label>
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
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "bg-slate-800 text-slate-300",
        tone === "good" && "bg-emerald-900/60 text-emerald-300",
        tone === "bad" && "bg-red-900/60 text-red-300",
        tone === "warn" && "bg-amber-900/60 text-amber-300",
      )}
    >
      {children}
    </span>
  );
}
