/**
 * Limits for one team, or one run (§10).
 *
 * The precedence chain has been mission > team > app since M4, resolved **field
 * by field** so a team that wants longer runs can set `timeout_sec` and keep
 * everything else — and until now the only layer with a screen was the app.
 *
 * That per-field rule is the whole design of this component. A blank box means
 * *inherit*, and the placeholder shows what inheriting gets you, so the answer
 * to "what will this actually run with" is on screen without doing arithmetic.
 * Overriding all four in order to change one is how two layers quietly drift
 * apart, and a form that made you type all four would cause exactly that.
 *
 * Empty and zero are different things, which is why the value is kept as a
 * string here rather than a number: `Number("")` is 0, and a token ceiling of 0
 * is a run that cannot take a step.
 */
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import type { BudgetLimits } from "../../transport/rest";

export type Overrides = Partial<Record<keyof BudgetLimits, string>>;

const ROWS: { field: keyof BudgetLimits; label: string; unit?: string }[] = [
  { field: "max_tokens", label: strings.budget.tokensLabel },
  { field: "timeout_sec", label: strings.budget.timeLabel, unit: strings.budget.seconds },
  { field: "max_llm_calls", label: strings.budget.callsLabel },
  { field: "max_supersteps", label: strings.budget.stepsLabel },
];

const FIELD = cn(
  "w-32 rounded-[9px] border border-line bg-solid px-3 py-1.5 text-right",
  "text-sm text-text placeholder:text-faint tabular-nums",
);

/** What the form should send: only the fields someone actually filled in. */
export function overridesToBody(values: Overrides): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { field } of ROWS) {
    const raw = (values[field] ?? "").trim();
    if (raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[field] = Math.trunc(n);
  }
  return out;
}

/** And the other direction, for editing something already saved. */
export function overridesFromBody(
  stored: Partial<Record<string, number>> | null | undefined,
): Overrides {
  const out: Overrides = {};
  for (const { field } of ROWS) {
    const value = stored?.[field];
    if (typeof value === "number") out[field] = String(value);
  }
  return out;
}

export function BudgetOverrides({
  values,
  inherited,
  onChange,
  inheritedFrom,
}: {
  values: Overrides;
  /** What each field is worth if left blank. Shown as the placeholder, so the
   *  effective limit never has to be worked out. */
  inherited: BudgetLimits | null;
  onChange: (next: Overrides) => void;
  inheritedFrom: string;
}) {
  const anySet = ROWS.some(({ field }) => (values[field] ?? "").trim() !== "");

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-snug text-faint">
        {strings.budget.inheritHint(inheritedFrom)}
      </p>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {ROWS.map(({ field, label, unit }) => (
          <label key={field} className="flex items-center gap-2 text-xs text-muted">
            <span className="w-[104px]">{label}</span>
            <input
              type="number"
              inputMode="numeric"
              value={values[field] ?? ""}
              placeholder={inherited ? String(inherited[field]) : ""}
              onChange={(e) => onChange({ ...values, [field]: e.target.value })}
              className={FIELD}
            />
            <span className="w-12 text-[11px] text-faint">{unit ?? ""}</span>
          </label>
        ))}
      </div>

      {anySet ? (
        <button
          type="button"
          onClick={() => onChange({})}
          className="rounded-card px-2 py-1 text-[11px] text-muted hover:bg-solid hover:text-text"
        >
          {strings.budget.clearOverrides(inheritedFrom)}
        </button>
      ) : null}
    </div>
  );
}
