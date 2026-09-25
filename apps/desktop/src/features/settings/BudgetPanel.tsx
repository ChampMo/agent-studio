/**
 * The ceilings every run is stopped at (§10).
 *
 * These four numbers have stopped runs since the first release and were
 * editable from nowhere. A team could be killed at 200,000 tokens with no
 * screen saying what that number was, where it came from, or how to raise it —
 * and the run it stopped was usually the one that had written the files and not
 * yet checked them.
 *
 * Two things this panel is careful to say, because both were invisible before:
 *
 * **They are ours.** Nothing here is a limit the endpoint imposes. It is the
 * point at which *this app* stops a run, which is a different claim entirely
 * and is worth making in those words.
 *
 * **Each one fails differently.** "Out of budget" is one phrase for four
 * problems with four fixes, so each row says what running out of that
 * particular thing looks like. A limit you cannot connect to a failure you have
 * seen is a number you will never knowingly change.
 *
 * The shipped values come from the backend rather than being repeated here, so
 * "reset" cannot drift from what a fresh install actually gets.
 *
 * **Four boxes were four answers to one question.** They are not independent:
 * the run this was rebuilt for spent 198,857 of 200,000 tokens while sitting
 * at 3:59 of 15:00, 22 of 40 calls and 6 of 60 steps — one box did anything at
 * all. Told "Out of tokens", the obvious move is to raise that one, and the
 * next run then meets the clock and reports a different limit. So the ordinary
 * choice is one step that moves all four, and the boxes are still there behind
 * "set each one myself" for anyone who has a budget rather than a size in mind.
 *
 * What makes the steps honest is the line under each one: how many runs on
 * *this machine* spent fewer tokens than that ceiling. A step named "medium"
 * would be the app claiming to know what a job costs, which it cannot — the
 * two finished runs here are 12,856 and 198,857 tokens (§1.1). A measurement
 * of what already happened is a different kind of statement, and it is one
 * this app can actually make.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { formatCount } from "../../lib/format";
import { api, type BudgetLimits } from "../../transport/rest";
import { TIERS, runsUnder, same, tierFor, type Tier } from "./tiers";

type Field = keyof BudgetLimits;

const ROWS: { field: Field; label: string; hint: string; unit?: string }[] = [
  {
    field: "max_tokens",
    label: strings.budget.tokensLabel,
    hint: strings.budget.tokensHint,
  },
  {
    field: "timeout_sec",
    label: strings.budget.timeLabel,
    hint: strings.budget.timeHint,
    unit: strings.budget.seconds,
  },
  {
    field: "max_llm_calls",
    label: strings.budget.callsLabel,
    hint: strings.budget.callsHint,
  },
  {
    field: "max_supersteps",
    label: strings.budget.stepsLabel,
    hint: strings.budget.stepsHint,
  },
];

/** A ceiling's clock, as a person would say it. Whole minutes up to an hour,
 *  whole hours past it — a step is a round number by construction, so there is
 *  no case here where "1 h 12 m" would be the honest answer. */
function spanOf(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = seconds / 3600;
  const shown = Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10;
  return `${shown} ${shown === 1 ? "hour" : "hours"}`;
}

/**
 * The chosen mark, drawn.
 *
 * A native `<input type="radio">` is rendered by WebView2, and an unchecked one
 * on this theme comes out as a solid dark dot — so every row read as selected
 * and the panel said nothing. Same lesson as the scrollbars: a native control
 * in this app is chrome the design still has to reach.
 *
 * It is never the only signal. The chosen row also says what being chosen does,
 * in words, because colour and shape alone are not a status (§18.3).
 */
function Mark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
        // `border-line` is a hairline token and measured 1.2:1 against the
        // dark panel — an unselected control you cannot see is a control that
        // does not look like one (WCAG 1.4.11 wants 3:1). `faint` measures
        // 5.94:1 dark and 4.30:1 light. Measured in both, not assumed.
        on ? "border-accent" : "border-faint",
      )}
    >
      {on ? <span className="size-2 rounded-full bg-accent" /> : null}
    </span>
  );
}

const FIELD = cn(
  "w-full rounded-[9px] border border-line bg-solid px-3 py-2",
  "text-sm text-text placeholder:text-faint tabular-nums",
);

export function BudgetPanel() {
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [saved, setSaved] = useState<BudgetLimits | null>(null);
  const [shipped, setShipped] = useState<BudgetLimits | null>(null);
  const [busy, setBusy] = useState(false);
  //: `null` while nothing has been read back. Not `[]`, which would say the
  //: machine has no finished runs — our own gap must never be written down as
  //: a fact about the world (§1.1).
  const [spent, setSpent] = useState<number[] | null>(null);
  //: A tier id, or "custom". Derived from what is saved on first read, so a
  //: machine already sitting on hand-set numbers opens with the boxes showing.
  const [choice, setChoice] = useState<string>("custom");
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = (value: BudgetLimits, ship: BudgetLimits) => {
    setSaved(value);
    setShipped(ship);
    setChoice(tierFor(value)?.id ?? "custom");
    setDraft({
      max_tokens: String(value.max_tokens),
      max_llm_calls: String(value.max_llm_calls),
      max_supersteps: String(value.max_supersteps),
      timeout_sec: String(value.timeout_sec),
    });
  };

  useEffect(() => {
    void api
      .budget()
      .then((r) => load(r.value, r.shipped))
      .catch((err) => setError((err as Error).message));
    // Separately, and failing quietly: a machine that cannot report what its
    // runs cost still has to be able to set a limit. The steps simply carry no
    // evidence line, which is the truthful rendering of not knowing.
    void api
      .budgetSpend()
      .then((r) => setSpent(r.runs.map((run) => run.tokens)))
      .catch(() => setSpent(null));
  }, []);

  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), 4000);
    return () => window.clearTimeout(timer);
  }, [said]);

  if (!draft || !saved || !shipped) {
    return <p className="text-xs text-faint">{error ?? strings.budget.loading}</p>;
  }

  // Compared as written, so "200000" and "200,000" are not treated as a change
  // and the button is not offered for a save that would do nothing.
  const changed = ROWS.some(
    ({ field }) => Number(draft[field]) !== saved[field],
  );
  const isDefault = ROWS.every(({ field }) => saved[field] === shipped[field]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setBudget({
        max_tokens: Number(draft.max_tokens),
        max_llm_calls: Number(draft.max_llm_calls),
        max_supersteps: Number(draft.max_supersteps),
        timeout_sec: Number(draft.timeout_sec),
      });
      load(next.value, next.shipped);
      setSaid(strings.budget.saved);
    } catch (err) {
      // The backend names the field and its range. Repeating that here rather
      // than replacing it with "invalid" is the difference between a fix and a
      // guess.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (tier: Tier) => {
    setChoice(tier.id);
    setDraft({
      max_tokens: String(tier.max_tokens),
      max_llm_calls: String(tier.max_llm_calls),
      max_supersteps: String(tier.max_supersteps),
      timeout_sec: String(tier.timeout_sec),
    });
  };

  return (
    <div className="space-y-4">
      <p className="max-w-xl text-[11px] leading-snug text-faint">
        {strings.budget.stepsLead}
      </p>

      <div
        role="radiogroup"
        aria-label={strings.budget.title}
        className="divide-y divide-line border-y border-line"
      >
        {TIERS.map((tier) => {
          const chosen = choice === tier.id;
          const under = spent === null ? null : runsUnder(tier.max_tokens, spent);
          return (
            <button
              key={tier.id}
              type="button"
              role="radio"
              aria-checked={chosen}
              onClick={() => pick(tier)}
              className="flex w-full items-start gap-3 py-3 text-left"
            >
              <Mark on={chosen} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm text-text tabular-nums">
                    {strings.budget.tierLabel(
                      formatCount(tier.max_tokens),
                      spanOf(tier.timeout_sec),
                    )}
                  </span>
                  <span className="text-[11px] text-faint tabular-nums">
                    {strings.budget.tierAside(tier.max_llm_calls, tier.max_supersteps)}
                  </span>
                  {/* Read off the backend's own defaults rather than marked on
                      the table here, so the two cannot drift. */}
                  {/* What being selected *means*, said rather than implied.
                      A mark on its own is a decoration to interpret (§18.3). */}
                  {chosen ? (
                    <span className="shrink-0 text-[11px] text-accent">
                      {strings.budget.tierChosen}
                    </span>
                  ) : null}
                  {same(tier, shipped) ? (
                    <span className="rounded-card border border-line px-1.5 py-px text-[10px] text-muted">
                      {strings.budget.tierShipped}
                    </span>
                  ) : null}
                </span>
                {/* A measurement of what happened, never a forecast of what
                    will — and only on a step that some recorded run would have
                    been stopped by. A count equal to the total is true of
                    every step above it too, so printing it four times teaches
                    the reader to stop reading the grey line. */}
                {under !== null && spent !== null && under < spent.length ? (
                  <span className="mt-0.5 block text-[11px] text-faint">
                    {strings.budget.tierUnder(under, spent.length)}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          role="radio"
          aria-checked={choice === "custom"}
          onClick={() => setChoice("custom")}
          className="flex w-full items-start gap-3 py-3 text-left"
        >
          <Mark on={choice === "custom"} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-text">{strings.budget.custom}</span>
            <span className="mt-0.5 block text-[11px] text-faint">
              {strings.budget.customHint}
            </span>
          </span>
        </button>
      </div>

      {/* Said once, under the group: the biggest run on this machine is the
          number that actually decides which step to pick, and it is the same
          fact however many steps are on screen. */}
      {spent !== null ? (
        <p className="text-[11px] text-faint">
          {spent.length === 0
            ? strings.budget.tierNoHistory
            : strings.budget.tierBiggest(
                formatCount(Math.max(...spent)),
                spent.length,
              )}
        </p>
      ) : null}

      <div
        hidden={choice !== "custom"}
        className="divide-y divide-line border-y border-line"
      >
        {ROWS.map(({ field, label, hint, unit }) => (
          <div key={field} className="flex flex-wrap items-start gap-4 py-3">
            <div className="min-w-0 flex-1">
              <label
                htmlFor={`budget-${field}`}
                className="block text-sm font-medium text-text"
              >
                {label}
              </label>
              <p className="mt-0.5 max-w-md text-[11px] leading-snug text-faint">
                {hint}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input
                id={`budget-${field}`}
                type="number"
                inputMode="numeric"
                value={draft[field]}
                onChange={(e) =>
                  setDraft({ ...draft, [field]: e.target.value })
                }
                className={cn(FIELD, "w-36 text-right")}
              />
              {unit ? (
                <span className="w-14 text-[11px] text-faint">{unit}</span>
              ) : (
                <span className="w-14" />
              )}
            </div>
          </div>
        ))}
      </div>

      {error ? <p className="text-xs text-stop">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !changed}
          onClick={() => void save()}
          className={cn(
            "min-h-[24px] rounded-[9px] bg-accent px-4 py-2 text-sm font-medium",
            "text-[#08222c] transition-[filter] hover:brightness-110",
            "disabled:opacity-40",
          )}
        >
          {busy ? strings.budget.saving : strings.budget.save}
        </button>

        {!isDefault ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft({
                max_tokens: String(shipped.max_tokens),
                max_llm_calls: String(shipped.max_llm_calls),
                max_supersteps: String(shipped.max_supersteps),
                timeout_sec: String(shipped.timeout_sec),
              });
              // The radio has to follow, or the panel shows one step selected
              // and four different numbers under it.
              setChoice(tierFor(shipped)?.id ?? "custom");
            }}
            className="min-h-[24px] rounded-card px-2 py-1 text-xs text-muted hover:bg-solid hover:text-text"
          >
            {strings.budget.reset}
          </button>
        ) : null}

        <span role="status" aria-live="polite" className="text-[11px] text-faint">
          {said}
        </span>
      </div>

      <p className="max-w-xl text-[11px] leading-snug text-faint">
        {strings.budget.appliesTo}
      </p>
    </div>
  );
}
