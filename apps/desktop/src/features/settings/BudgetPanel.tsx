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
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { api, type BudgetLimits } from "../../transport/rest";

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

const FIELD = cn(
  "w-full rounded-[9px] border border-line bg-solid px-3 py-2",
  "text-sm text-text placeholder:text-faint tabular-nums",
);

export function BudgetPanel() {
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [saved, setSaved] = useState<BudgetLimits | null>(null);
  const [shipped, setShipped] = useState<BudgetLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = (value: BudgetLimits, ship: BudgetLimits) => {
    setSaved(value);
    setShipped(ship);
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

  return (
    <div className="space-y-4">
      <div className="divide-y divide-line border-y border-line">
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
            onClick={() =>
              setDraft({
                max_tokens: String(shipped.max_tokens),
                max_llm_calls: String(shipped.max_llm_calls),
                max_supersteps: String(shipped.max_supersteps),
                timeout_sec: String(shipped.timeout_sec),
              })
            }
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
