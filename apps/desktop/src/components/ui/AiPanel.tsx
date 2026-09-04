/**
 * The box a model writes inside (§18.3).
 *
 * Two places ask a model to fill a form in — the agent creator drafts a
 * character, the team builder staffs a team — and both had the same problem:
 * you press a button, nothing changes for between five and forty seconds, and
 * then a form is suddenly full of text with nothing saying where it came from.
 *
 * So this component carries exactly two facts, and both are things the app
 * knows rather than things it is guessing:
 *
 * **Something is running, and for how long.** The elapsed second is the one
 * honest measure of a wait whose length nobody can predict — and it is what
 * answers the question a stalled screen actually provokes, which is *is this
 * stuck, or is it thinking?*
 *
 * **This text came from a model and you have not checked it.** That is the
 * visual form of a sentence the app already prints — "nothing is saved until
 * you press Save" — and it is why the treatment has to *leave* on save.
 *
 * ### What this deliberately does not draw
 *
 * A row of named steps — *reading the brief → drafting → choosing an avatar* —
 * was the obvious thing to put in the working state, and it would have been
 * invented. `POST /agents/generate` returns one JSON object at the end;
 * nothing streams, and the backend reports no progress at all. A bar filling
 * through four captions would be the screen narrating work it cannot see,
 * which is the same reasoning that keeps a "model calls 18 / 60" row off the
 * budget panel (§1.1). What is drawn instead is an indeterminate bar, which
 * claims a fact — something is running — and no proportion.
 *
 * `attempts` is the one piece of progress that is real, and it arrives with
 * the answer rather than during the wait, so it is reported afterwards by the
 * caller rather than animated here.
 */
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/cn";
import { strings } from "../../lib/constants/strings.en";

export type AiState = "idle" | "working" | "unreviewed" | "failed";

/** The mark on a field a model wrote and nobody has edited yet. Exported as a
 *  class name rather than a component: it goes on inputs, textareas and plain
 *  divs, which have nothing else in common. */
export const AI_WRITTEN = "ai-written pl-3.5";

export function Sparkle({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 2.6l1.7 5.1a4 4 0 002.5 2.5l5.1 1.7-5.1 1.7a4 4 0 00-2.5 2.5L12 21.4l-1.7-5.3a4 4 0 00-2.5-2.5L2.7 12l5.1-1.7a4 4 0 002.5-2.5L12 2.6z" />
    </svg>
  );
}

/**
 * Seconds since the wait started, or null when nothing is running.
 *
 * The interval only exists while it is needed, and it is keyed on `since` — a
 * second run has to restart the clock rather than continue the first one's.
 * Reading the elapsed time from a stored start rather than counting ticks
 * means a throttled background tab shows the true figure when it comes back
 * instead of however many ticks it was allowed.
 */
function useElapsed(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [since]);
  return since === null ? null : Math.max(0, Math.floor((now - since) / 1000));
}

export function AiPanel({
  state,
  title,
  model,
  children,
  actions,
  /** When the current run started, for the clock. Null unless working. */
  startedAt = null,
  /** Shown in the header once the work is in and waiting to be checked. */
  reviewNote,
  /** The endpoint's own words. Kept inside the panel rather than raised as a
   *  toast, so it sits beside the form that produced it and the text that was
   *  typed is still on screen underneath. */
  error,
}: {
  state: AiState;
  title: string;
  model: string | null;
  children: React.ReactNode;
  actions?: React.ReactNode;
  startedAt?: number | null;
  reviewNote?: string;
  error?: string | null;
}) {
  const elapsed = useElapsed(state === "working" ? startedAt : null);

  return (
    <div className="ai-panel" data-state={state}>
      <div className="ai-inner flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-ai-ink">
            <Sparkle size={18} />
          </span>
          <span className="text-sm font-medium text-text">{title}</span>

          {/* Which endpoint is about to be paid, on the panel that spends it. */}
          {model ? (
            <span className="ml-auto truncate rounded border border-line px-2 py-0.5 font-mono text-[11px] text-faint">
              {model}
            </span>
          ) : null}
        </div>

        {children}

        {/* The working strip. A bar with no proportion and a clock that is
            real — see the module comment on why there are no step captions. */}
        {state === "working" ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-ai-ink">
                {strings.ai.working}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-faint">
                {elapsed === null ? "" : strings.ai.elapsed(elapsed)}
              </span>
            </div>
            <div className="h-[3px] overflow-hidden rounded-full bg-solid-2">
              <span className="ai-sweep block h-full w-[30%] rounded-full" />
            </div>
          </div>
        ) : null}

        {state === "unreviewed" && reviewNote ? (
          <p className="text-xs text-ai-ink">{reviewNote}</p>
        ) : null}

        {/* In the box, never a toast. A failure that is announced somewhere
            else and takes the form with it is how a feature stops being
            used — what was typed is still above this line. */}
        {error ? (
          <p className="text-xs leading-snug text-stop">{error}</p>
        ) : null}

        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The button that spends money, and the one that stops it.
 *
 * The cancel is not decoration and not a hidden panel: it aborts the request.
 * A model that hangs for sixty seconds behind a screen with nothing to press
 * is worse than not having the feature, and hiding the spinner while the
 * fetch carries on would leave the reply landing on a form the person had
 * already moved on from.
 */
export function AiButton({
  onClick,
  disabled,
  busy,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        "flex min-h-[32px] items-center gap-2 rounded-card px-3.5 text-xs font-medium",
        "border border-ai-b/45 bg-ai-wash text-ai-ink",
        "transition-colors hover:bg-ai-b/15 disabled:opacity-55 disabled:hover:bg-ai-wash",
      )}
    >
      <Sparkle size={14} />
      {children}
    </button>
  );
}

/**
 * A run that can be called off.
 *
 * `AbortController` per run, and the controller is what `cancel` acts on, so
 * pressing it closes the connection rather than only tidying the screen.
 * `startedAt` is set here because the clock and the request have to begin
 * together — a clock started by a render would be measuring the wrong thing.
 */
export function useAiRun() {
  const abort = useRef<AbortController | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // A run outliving the form that started it would resolve into a component
  // that is gone.
  useEffect(() => () => abort.current?.abort(), []);

  return {
    startedAt,
    begin(): AbortSignal {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setStartedAt(Date.now());
      return controller.signal;
    },
    end() {
      abort.current = null;
      setStartedAt(null);
    },
    cancel() {
      abort.current?.abort();
      abort.current = null;
      setStartedAt(null);
    },
  };
}
