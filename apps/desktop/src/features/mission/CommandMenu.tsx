/**
 * The list that opens when you type `/`.
 *
 * It is a menu of things the **app** does, sitting above a box whose every
 * other use sends words to four models. That difference is the only thing this
 * component really has to communicate, so it says it in a line at the bottom
 * rather than leaving the slash to imply it.
 *
 * Keyboard first, because a menu you reach by typing is a menu you leave by
 * typing: arrows move, Enter takes, Escape closes and leaves what you wrote
 * exactly as it was. Nothing here is reachable only by mouse (WCAG 2.1.1).
 */
import { useEffect, useRef } from "react";

import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import type { CommandSpec } from "./commands";

interface Props {
  specs: CommandSpec[];
  active: number;
  onPick: (spec: CommandSpec) => void;
  onHover: (index: number) => void;
}

/**
 * The same list, for `@`.
 *
 * Deliberately a separate component rather than one that takes either kind of
 * row. The footers say opposite things — a command is *not* sent to the team
 * and an addressed note is sent to exactly one of them — and that sentence is
 * the whole reason either menu exists. Merging them would mean a conditional
 * in the one place that must never be wrong.
 */
export function NameMenu({
  names,
  active,
  onPick,
  onHover,
}: {
  names: string[];
  active: number;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = list.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (names.length === 0) return null;

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 z-20 mb-1.5 w-[min(20rem,100%)]",
        "overflow-hidden rounded-card border border-line bg-solid-2 shadow-lg",
      )}
    >
      <ul ref={list} className="max-h-64 overflow-y-auto py-1" role="listbox">
        {names.map((name, index) => (
          <li key={name} role="option" aria-selected={index === active}>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(name);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                "flex w-full min-h-[24px] items-center px-3 py-1.5 text-left text-xs",
                index === active
                  ? "bg-solid text-text"
                  : "text-muted hover:bg-solid",
              )}
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-3 py-1.5 text-[11px] text-faint">
        {strings.commands.nameFooter}
      </p>
    </div>
  );
}

export function CommandMenu({ specs, active, onPick, onHover }: Props) {
  const list = useRef<HTMLUListElement>(null);

  // Keep the highlighted row visible when the arrows walk past the edge.
  useEffect(() => {
    const el = list.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (specs.length === 0) return null;

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 z-20 mb-1.5 w-[min(26rem,100%)]",
        "overflow-hidden rounded-card border border-line bg-solid-2 shadow-lg",
      )}
    >
      <ul ref={list} className="max-h-64 overflow-y-auto py-1" role="listbox">
        {specs.map((spec, index) => (
          <li key={spec.id} role="option" aria-selected={index === active}>
            <button
              type="button"
              // `onMouseDown` rather than `onClick`: the textarea has focus and
              // a click would blur it first, closing the menu out from under
              // the press.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(spec);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                "flex w-full min-h-[24px] flex-col items-start gap-0.5 px-3 py-1.5 text-left",
                index === active ? "bg-solid" : "hover:bg-solid",
              )}
            >
              <span className="font-mono text-xs text-text">/{spec.name}</span>
              <span className="text-[11px] leading-snug text-muted">
                {spec.summary}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* The one thing this menu exists to make clear. */}
      <p className="border-t border-line px-3 py-1.5 text-[11px] text-faint">
        {strings.commands.menuFooter}
      </p>
    </div>
  );
}
