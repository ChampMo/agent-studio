/**
 * What a mission's state looks like, and what it is called (§18.3).
 *
 * Two rules, both of which the old build broke:
 *
 * * **A colour is not a status.** Every state here carries a shape as well, so
 *   the five of them are still five things when the colour is not available —
 *   to someone who cannot distinguish them, on a bad screen, in sunlight.
 * * **A status is a word, not a code.** "1/2" and a green dot say nothing on
 *   their own; "1 of 2 tasks done" and "Finished" do.
 *
 * Pure, so both are testable and so an unknown state coming off the log
 * degrades to something neutral rather than throwing (§8).
 */

export type MissionShape = "circle" | "diamond" | "triangle" | "square" | "ring";

export interface MissionLook {
  shape: MissionShape;
  /** A token name from index.css, not a hex value. */
  tone: "done" | "search" | "write" | "wait" | "stop" | "idle";
  /** What to call it, in words. */
  label: string;
}

const LOOKS: Record<string, MissionLook> = {
  completed: { shape: "circle", tone: "done", label: "Finished" },
  running: { shape: "diamond", tone: "search", label: "Working" },
  waiting: { shape: "triangle", tone: "wait", label: "Waiting on you" },
  failed: { shape: "square", tone: "stop", label: "Stopped badly" },
  crashed: { shape: "square", tone: "stop", label: "Stopped badly" },
  // Amber, not red. Running out of budget is not the work going wrong — it is
  // a ceiling being reached, and the ceiling is one this app set rather than
  // anything the team did badly. Red is for `failed` and `crashed`, where
  // something broke; this is the same distinction the ending line already
  // draws by naming which limit it was.
  budget_exceeded: { shape: "square", tone: "wait", label: "Out of budget" },
  cancelled: { shape: "ring", tone: "idle", label: "You stopped it" },
};

const UNKNOWN: MissionLook = { shape: "ring", tone: "idle", label: "Unknown" };

/**
 * Which ceiling, when one of them is why the run stopped.
 *
 * `budget_exceeded` covers tokens, model calls, graph steps and wall-clock
 * time — four problems whose fixes are nothing like each other: raise the
 * allowance, simplify the plan, use fewer agents, give it longer. Rendered as
 * one phrase, three runs in a row that were stopped by the *clock* were read
 * as having run out of tokens, including by the person writing them up, who
 * then went and looked for the tokens.
 *
 * The reason was on the log the whole time, in the ending's own summary. It
 * was the label above it that flattened them.
 */
const LIMITS: Record<string, string> = {
  tokens: "Out of tokens",
  llm_calls: "Too many model calls",
  supersteps: "Too many steps",
  time: "Out of time",
};

/**
 * The look for a mission, from its status and — when it has ended — its reason.
 *
 * `end_reason` is the more specific of the two and wins: "ended" is not a
 * state anyone cares about, "Finished" and "Stopped badly" are.
 */
export function missionLook(
  status: string | null | undefined,
  endReason?: string | null,
  /** Which ceiling, for `budget_exceeded`. Absent on rounds recorded before
   *  the field existed, which keep the general phrase — it was true of them,
   *  just less useful (§8). */
  limit?: string | null,
): MissionLook {
  if (endReason === "budget_exceeded" && limit && LIMITS[limit]) {
    return { ...LOOKS.budget_exceeded!, label: LIMITS[limit]! };
  }
  if (endReason && LOOKS[endReason]) return LOOKS[endReason]!;
  if (status && LOOKS[status]) return LOOKS[status]!;
  return UNKNOWN;
}

/** Agent-level poses, for the dots beside a team member. */
const AGENT_LOOKS: Record<string, MissionLook> = {
  idle: { shape: "ring", tone: "idle", label: "Idle" },
  thinking: { shape: "diamond", tone: "search", label: "Thinking" },
  working: { shape: "diamond", tone: "write", label: "Working" },
  waiting: { shape: "triangle", tone: "wait", label: "Waiting on you" },
  blocked: { shape: "square", tone: "stop", label: "Blocked" },
};

export function agentLook(status: string | null | undefined): MissionLook {
  return (status && AGENT_LOOKS[status]) || AGENT_LOOKS.idle!;
}
