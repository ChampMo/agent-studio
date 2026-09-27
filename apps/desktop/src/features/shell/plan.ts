/**
 * The plan and where it has got to, derived from the log.
 *
 * `mission.progress` is published for every task at every state change, and
 * the timeline printed each one as its own centred line — five `pending 0/5`
 * rows directly under a plan message that had just listed the same five tasks.
 * True, and duplication, and it pushed the run's actual content off screen.
 *
 * A task's state is not history; it is **where things stand**, which is what a
 * panel is for and what a log is not. So the rows fold away and this is the
 * thing that answers the question they were badly answering.
 *
 * Scoped to the round on screen, on the rule the rest of the app follows: the
 * first event after an ending opens the next round, and the previous round's
 * plan was carried out already.
 */
import type { SequencedEntry } from "../../stores/eventStore";

/**
 * `stopped` is a task this app cut off at one of its own ceilings before it
 * could deliver. It is deliberately not `failed`: a limit is a budget to
 * raise and a failure is work to look at, and one word for both sent people
 * to the wrong one.
 */
export type TaskState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "stopped";

export interface PlanTask {
  id: string;
  title: string;
  state: TaskState;
}

export interface PlanProgress {
  tasks: PlanTask[];
  done: number;
  failed: number;
  /** Cut off at one of this app's own ceilings, rather than having failed. */
  stopped: number;
  /** How many are neither finished nor finished-with — what is actually left. */
  left: number;
}

const KNOWN: TaskState[] = ["pending", "running", "done", "failed", "stopped"];

/** One round's plan, and how that round ended. */
export interface PlanRound extends PlanProgress {
  /** 1-based, in the order the rounds happened. */
  round: number;
  /** What the round was asked. The first message of a round creates it. */
  asked: string | null;
  /** `null` while this is the round still going. */
  endReason: string | null;
  endLimit: string | null;
}

/**
 * Every round's plan, oldest first.
 *
 * A continued run appends to the same log, so the rounds are already all there
 * — each one's tasks, what it was asked, and how it ended. Nothing is stored
 * for this and nothing should be: a second place saying what a round planned
 * is a second place to be wrong, and the log is the record (§2.1).
 *
 * `planProgress` is the last of these, so the panel at the top of the rail and
 * the history underneath it cannot disagree about the round on screen.
 */
export function planRounds(events: SequencedEntry[]): PlanRound[] {
  const rounds: PlanRound[] = [];
  let order: string[] = [];
  let byId = new Map<string, PlanTask>();
  let asked: string | null = null;
  let open = false;

  const close = (endReason: string | null, endLimit: string | null) => {
    // A round with no plan is still a round that happened — the one that died
    // in planning is exactly the one worth being able to look at.
    if (!open) return;
    const tasks = order.map((id) => byId.get(id)!);
    const done = tasks.filter((t) => t.state === "done").length;
    const failed = tasks.filter((t) => t.state === "failed").length;
    const stopped = tasks.filter((t) => t.state === "stopped").length;
    rounds.push({
      round: rounds.length + 1,
      tasks,
      done,
      failed,
      stopped,
      // `stopped` is finished-with too: it will not run again in this round,
      // so counting it as "left" would report work as outstanding that the
      // round has already given up on.
      left: tasks.length - done - failed - stopped,
      asked,
      endReason,
      endLimit,
    });
    order = [];
    byId = new Map();
    asked = null;
    open = false;
  };

  for (const { event } of events) {
    const type = event.draft.type;
    const p = event.draft.payload as unknown as Record<string, unknown>;

    if (type === "mission.ended") {
      close(
        typeof p.reason === "string" ? p.reason : null,
        typeof p.limit === "string" ? p.limit : null,
      );
      continue;
    }
    open = true;
    if (type === "user.message" && asked === null) {
      const content = typeof p.content === "string" ? p.content : "";
      asked = content.trim() || null;
    }
    if (type !== "mission.progress") continue;

    const id = String(p.taskId ?? "");
    if (!id) continue;
    const raw = String(p.state ?? "");
    // A state this build has never heard of is kept as pending rather than
    // dropped: the task exists, and guessing it finished would be worse than
    // showing it as not yet done (§8).
    const state = (KNOWN as string[]).includes(raw) ? (raw as TaskState) : "pending";
    if (!byId.has(id)) order.push(id);
    byId.set(id, { id, title: String(p.label ?? id), state });
  }
  // The round still going has no ending yet, which is the thing that marks it.
  close(null, null);
  return rounds;
}

/**
 * The plan of the round on screen.
 *
 * Defined as the last of `planRounds` rather than walked separately, so "what
 * is the current plan" has one answer. The old version was its own loop with
 * the same round-boundary rule copied into it.
 */
export function planProgress(events: SequencedEntry[]): PlanProgress {
  const rounds = planRounds(events);
  const last = rounds[rounds.length - 1];
  return last ?? { tasks: [], done: 0, failed: 0, stopped: 0, left: 0 };
}
