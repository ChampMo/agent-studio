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

export type TaskState = "pending" | "running" | "done" | "failed";

export interface PlanTask {
  id: string;
  title: string;
  state: TaskState;
}

export interface PlanProgress {
  tasks: PlanTask[];
  done: number;
  failed: number;
  /** How many are neither finished nor failed — what is actually left. */
  left: number;
}

const KNOWN: TaskState[] = ["pending", "running", "done", "failed"];

export function planProgress(events: SequencedEntry[]): PlanProgress {
  let order: string[] = [];
  let byId = new Map<string, PlanTask>();
  let ended = false;

  for (const { event } of events) {
    const type = event.draft.type;

    // A new round replaces the previous one's plan entirely.
    if (ended && type !== "mission.ended") {
      order = [];
      byId = new Map();
      ended = false;
    }
    if (type === "mission.ended") {
      ended = true;
      continue;
    }
    if (type !== "mission.progress") continue;

    const p = event.draft.payload as unknown as Record<string, unknown>;
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

  const tasks = order.map((id) => byId.get(id)!);
  const done = tasks.filter((t) => t.state === "done").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  return { tasks, done, failed, left: tasks.length - done - failed };
}
