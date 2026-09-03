/**
 * This round, against the limits that actually stop it.
 *
 * A ring and nothing else, beside the box where the next instruction is typed
 * — which is where the question "have I got room for another go at this?"
 * actually comes up. As three labelled rows in the rail it was competing with
 * the conversation's totals for the same strip of window, and repeating a
 * measurement most of the time nobody is asking about.
 *
 * **Whichever limit is nearest is the one drawn**, because that is the one
 * that will stop the round. A meter showing tokens at 20% while the clock is
 * at 95% would be truthful about the wrong number — and three runs in a row
 * this week were stopped by the clock while everyone was watching the tokens.
 *
 * No visible label, but not no name: the ring carries its reading in
 * `aria-label`, and the detail opens on hover **and** on keyboard focus, and
 * is dismissible with Escape (WCAG 1.4.13). Content that only appears on hover
 * is content that does not exist for anyone reaching it another way — dropping
 * the words has to mean moving them, not deleting them.
 */
import { useEffect, useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useMissionStore } from "../../stores/missionStore";
import { formatDuration } from "./vitals";
import { useVitals } from "./useVitals";

//: 2πr for r=7, so the dash length is the fraction of the circle to fill.
const CIRCUMFERENCE = 2 * Math.PI * 7;

export function RoundMeter() {
  const missionId = useMissionStore((s) => s.missionId);
  const vitals = useVitals();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (missionId === null) return null;
  if (!vitals.maxTokens && !vitals.timeoutMs) return null;

  const ratio = Math.min(
    1,
    Math.max(
      0,
      vitals.maxTokens ? vitals.tokens / vitals.maxTokens : 0,
      vitals.timeoutMs ? vitals.elapsedMs / vitals.timeoutMs : 0,
    ),
  );
  const percent = Math.round(ratio * 100);
  const tone = ratio >= 1 ? "text-stop" : ratio >= 0.8 ? "text-wait" : "text-done";

  return (
    <div className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-expanded={open}
        aria-label={strings.rail.roundUsed(percent)}
        className={cn(
          "flex size-[24px] items-center justify-center rounded-card",
          "text-muted hover:bg-solid hover:text-text",
        )}
      >
        <svg viewBox="0 0 18 18" className={cn("size-[16px]", tone)} aria-hidden>
          <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2.5" className="stroke-line" />
          <circle
            cx="9"
            cy="9"
            r="7"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${ratio * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>

      {open ? (
        <dl
          className={cn(
            "absolute bottom-full right-0 z-20 mb-1 w-[15rem] space-y-1.5 rounded-[9px] p-3",
            "border border-line bg-solid-2 text-xs shadow-lg",
          )}
        >
          <p className="pb-0.5 text-[11px] font-medium text-faint">
            {strings.rail.roundUsed(percent)}
          </p>
          <Row
            label={strings.rail.tokensUsed}
            value={vitals.tokens.toLocaleString("en")}
            limit={vitals.maxTokens?.toLocaleString("en") ?? null}
          />
          <Row
            label={strings.rail.timeUsed}
            value={formatDuration(vitals.elapsedMs)}
            limit={vitals.timeoutMs ? formatDuration(vitals.timeoutMs) : null}
          />
          <Row label={strings.rail.replies} value={String(vitals.replies)} limit={null} />
          {/* No note about time parked on a question. `elapsedMs` already
              excludes it — the subtraction is the honest part and it stays —
              but explaining the subtraction every time turned a one-off
              subtlety into a permanent paragraph. "Time used" is the time the
              team used; that is what the row says and it is true. */}
        </dl>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  limit,
}: {
  label: string;
  value: string;
  limit: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="shrink-0 tabular-nums text-text">
        {value}
        {limit ? <span className="text-faint"> / {limit}</span> : null}
      </dd>
    </div>
  );
}
