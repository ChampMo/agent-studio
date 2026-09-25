/**
 * The ceilings offered as one choice instead of four.
 *
 * Four independent boxes made you answer, separately, how many tokens, how
 * many seconds, how many model calls and how many steps a job is worth — and
 * they are not independent. A run stopped for tokens is told "Out of tokens",
 * so the tokens box is the one that gets raised; the next, bigger run then
 * hits the **clock** or the **call** ceiling and reports a different limit.
 * The app was teaching the coupling one failed run at a time.
 *
 * Measured on the run this came from: 198,857 of 200,000 tokens — and 3:59 of
 * 15:00, 22 of 40 calls, 6 of 60 steps. One box did anything at all.
 *
 * **A step is named for its ceiling, never for the job.** "Small" or "Medium"
 * would be this app claiming to know what a piece of work costs, which it
 * cannot: the two finished runs on the machine this was written on are 12,856
 * and 198,857 tokens, fifteen times apart, and nothing could have said so in
 * advance (§1.1). "Stop at 200,000 tokens" is a true statement about the app;
 * "a medium job" is a guess about the world.
 *
 * And the exact numbers stay reachable, because a ceiling is sometimes a real
 * budget somebody has to type.
 */
import type { BudgetLimits } from "../../transport/rest";

export interface Tier extends BudgetLimits {
  /** Stable id for the radio group, never shown. */
  id: string;
}

/**
 * Four steps.
 *
 * The middle one is what the app has always shipped. The two above it bracket
 * runs that really happened rather than being round numbers picked for the
 * look of them: 605,853 tokens on one build and 1,262,610 on another, both
 * recorded in this repo's own notes. The one below exists because most runs
 * are small and a lower ceiling is a cheaper mistake.
 *
 * Calls and steps rise with the rest. That is the entire point of a step — a
 * bigger job is more tasks as well as more tokens, and raising one number
 * alone only moves which wall you meet.
 */
export const TIERS: Tier[] = [
  { id: "t1", max_tokens: 100_000, timeout_sec: 600, max_llm_calls: 30, max_supersteps: 40 },
  { id: "t2", max_tokens: 200_000, timeout_sec: 900, max_llm_calls: 40, max_supersteps: 60 },
  { id: "t3", max_tokens: 600_000, timeout_sec: 2_700, max_llm_calls: 120, max_supersteps: 150 },
  { id: "t4", max_tokens: 1_500_000, timeout_sec: 7_200, max_llm_calls: 300, max_supersteps: 300 },
];

export const FIELDS = [
  "max_tokens",
  "timeout_sec",
  "max_llm_calls",
  "max_supersteps",
] as const;

export function same(a: BudgetLimits, b: BudgetLimits): boolean {
  return FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Which step these limits are, or `null` for a set nobody offered.
 *
 * Every field has to match. A machine sitting on three of four is *not* on
 * that step, and showing it as though it were would make the panel disagree
 * with the numbers underneath it.
 */
export function tierFor(value: BudgetLimits): Tier | null {
  return TIERS.find((tier) => same(tier, value)) ?? null;
}

/**
 * How many recorded runs spent fewer tokens than this ceiling.
 *
 * A measurement, not a forecast, and a narrow one: **tokens only**. A ceiling
 * is four numbers, so "would this run have fitted" is a question about four of
 * them — and the worked clock subtracts time parked on a question, which is a
 * derivation that already exists once. Writing it again to make a
 * fuller-sounding claim is the drift that rule exists to prevent, so the label
 * says "tokens" and means it.
 */
export function runsUnder(tokens: number, spent: number[]): number {
  return spent.filter((n) => n <= tokens).length;
}
