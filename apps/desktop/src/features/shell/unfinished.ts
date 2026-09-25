/**
 * The tasks a round did not finish, and what they were told to do.
 *
 * A run that stops early leaves its plan half-executed, and until now the only
 * way to pick one task back up was to run the whole round again — which pays
 * for everything that already succeeded in order to redo the one thing that
 * did not. On a real run that was `Review pages against component contracts`:
 * a verification task, which is the kind that gets cut most often and the kind
 * whose absence matters most, since it is what would have told you whether the
 * rest is true.
 *
 * Derived from the log like everything else (§2.1). `mission.progress` carries
 * each task's state as it changes, and the `pending` event that announces a
 * task carries the instruction it was given — so a retry can say exactly what
 * was asked rather than a paraphrase of the title.
 *
 * Scoped to the round on screen. A mission can be continued, so a task that
 * failed two rounds ago was already answered by the rounds after it, and
 * offering to redo it would be offering to redo history.
 */
import type { SequencedEntry } from "../../stores/eventStore";

export interface UnfinishedTask {
  id: string;
  title: string;
  /** What it was told to do. Empty for a round recorded before the field
   *  existed, where the title is all there is (§8). */
  instruction: string;
  /** `failed` ran and came back empty or broken; `pending` never started.
   *  Different problems: one needs a different approach, the other needs
   *  room. */
  state: "failed" | "pending";
}

const FINISHED = new Set(["done"]);

export function unfinishedTasks(events: SequencedEntry[]): UnfinishedTask[] {
  let order: string[] = [];
  let byId = new Map<string, UnfinishedTask>();
  let states = new Map<string, string>();
  let roundOver = false;

  events.forEach(({ event }) => {
    const type = event.draft.type;
    const p = event.draft.payload as unknown as Record<string, unknown>;

    if (type === "mission.ended") {
      roundOver = true;
      return;
    }
    if (type !== "mission.progress") return;
    // A new round replaces the previous one's plan — but only once it has one.
    //
    // The vitals and the scene clear theirs on the *first event* after an
    // ending, which is right for a counter and wrong for this: a round that
    // dies before it plans publishes no `mission.progress` at all, so there is
    // nothing to replace the list with and clearing it leaves the person with
    // no retry button and no next step. Seen on a real run — two unfinished
    // tasks before the retry, and none after the retry failed to plan, which
    // took away the one affordance that could have been pressed again.
    //
    // Holding the list until a plan arrives is also the truer reading: until
    // another round plans something, those tasks are still the unfinished ones.
    if (roundOver) {
      order = [];
      byId = new Map();
      states = new Map();
      roundOver = false;
    }

    const id = String(p.taskId ?? "");
    if (!id) return;
    if (!byId.has(id)) {
      order.push(id);
      byId.set(id, {
        id,
        title: String(p.label ?? ""),
        instruction: String(p.instruction ?? ""),
        state: "pending",
      });
    }
    states.set(id, String(p.state ?? ""));
  });

  const out: UnfinishedTask[] = [];
  for (const id of order) {
    const state = states.get(id) ?? "pending";
    if (FINISHED.has(state)) continue;
    // Still running is not unfinished — it is working, and offering to redo it
    // would be offering to run it twice at once.
    if (state === "running") continue;
    const task = byId.get(id)!;
    out.push({ ...task, state: state === "failed" ? "failed" : "pending" });
  }
  return out;
}

/**
 * What to send to pick one task back up.
 *
 * Deliberately the task's own instruction rather than a sentence about it. The
 * round it belonged to is already in front of the planner — every round's
 * message and ending is — so the thing missing was the instruction itself.
 */
export function retryMessage(task: UnfinishedTask): string {
  const why =
    task.state === "failed"
      ? "This task ran and produced nothing usable. Do it again"
      : "This task was planned and never started. Do it now";
  const what = task.instruction.trim();
  // The title on its own when there is no instruction to add. A round recorded
  // before instructions were kept has only the title, and the message read it
  // out twice one line apart — which looks like a bug rather than emphasis.
  // Seen on the first real use of the button.
  const body = what && what !== task.title ? `${task.title}\n\n${what}` : task.title;
  return `${why} — and only this task:\n\n${body}`;
}

/**
 * One message that picks up everything the round did not finish.
 *
 * A round per task would be a round per task: each one re-reads the workspace
 * and re-establishes what the others already know, and the planner is handed
 * the same history every time. What was left over is a plan already — the tail
 * of one the leader wrote — so it goes back as a plan.
 *
 * Each task keeps the instruction it was given, and keeps whether it ran and
 * came back empty or never started at all. Those need different things from
 * whoever picks them up, and flattening them into "do these" would throw away
 * the one piece of diagnosis the round produced for free.
 */
export function retryAllMessage(tasks: UnfinishedTask[]): string {
  const lines = tasks.map((task) => {
    const what = task.instruction.trim();
    const state =
      task.state === "failed"
        ? "ran and produced nothing usable"
        : "never started";
    const body = what && what !== task.title ? `\n   ${what}` : "";
    return `- ${task.title} (${state})${body}`;
  });
  return (
    "The last round stopped before these were done. Do them, and only " +
    `them:\n\n${lines.join("\n\n")}`
  );
}
