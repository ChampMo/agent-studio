/**
 * Who just spoke to whom (§2.1).
 *
 * Pure, and derived from two different events, because two different things are
 * being drawn.
 *
 * **Agent to agent** is the `send_message` tool. It was tempting to read
 * `agent.message.to` for this — the transcript already turns that into the
 * "→ Developer (Dev)" line beside a bubble — but on a real run that field is
 * only ever `user` or `broadcast`: an agent's *reply* goes to whoever is
 * listening, and a message to a teammate is a **tool call**. Reading the wrong
 * one produced a feature that could never draw the line it existed for, and it
 * looked like it worked because broadcasts still appeared.
 *
 * **Agent to the user, or to everyone** is `agent.message.to`, which is where
 * those genuinely live.
 *
 * `send_message` addresses people by **name**, not by id — "PM", "Dev",
 * "Tester" — so the name has to be resolved against the roster here. It is
 * resolved by the same rule `Mailbox.resolve` uses on the backend, including
 * the important half: **two teammates who both match means no line.** Drawing
 * an arrow to the wrong cat is the visual version of delivering a message to
 * the wrong person and reporting success, which is the worst failure that
 * mechanism has.
 *
 * Two refusals cover the rest:
 *
 * Nothing is drawn while replaying. A finished run's log is full of messages,
 * and animating them would say "these two are talking" about a conversation
 * that ended last week — the same mistake `shouldChime` exists to prevent.
 *
 * Nothing older than `WINDOW_MS` is drawn. A line is a claim about *now*; one
 * that stayed up would become a claim about the past in the present tense. A
 * timestamp this build cannot read is skipped rather than treated as now, and
 * one from the future is skipped too — our own inability to read a clock is not
 * evidence that something just happened (§3.1).
 */
import type { SequencedEntry } from "../../stores/eventStore";

/** How long a line stays up. Long enough to notice while glancing away from
 *  the transcript, short enough that it is still true when you look. */
export const WINDOW_MS = 6000;

export interface TalkLine {
  /** The event's own id, so React keys survive a re-derivation. */
  id: string;
  from: string;
  /** The recipient's agent id, or null when it went to the user or the whole
   *  team — those are drawn differently, because they are different. */
  to: string | null;
  kind: "agent" | "user" | "broadcast";
  at: number;
}

export interface Member {
  agentId: string;
  name: string;
}

/**
 * A typed name to an agent id, or null.
 *
 * Exact, then prefix, then contains — narrower before wider, so "Dev" prefers
 * the teammate whose name *starts* with it. Null on no match **and on more than
 * one**, which is the half that matters: `Mailbox.resolve` raises `Ambiguous`
 * rather than picking, and the drawing has to be at least as careful.
 */
export function resolveName(who: string, roster: Member[]): string | null {
  const wanted = who.trim().toLowerCase();
  if (!wanted) return null;

  const byId = roster.find((m) => m.agentId === who);
  if (byId) return byId.agentId;

  for (const test of [
    (name: string) => name === wanted,
    (name: string) => name.startsWith(wanted),
    (name: string) => name.includes(wanted),
  ]) {
    const hits = roster.filter((m) => test(m.name.trim().toLowerCase()));
    if (hits.length === 1) return hits[0]!.agentId;
    if (hits.length > 1) return null;
  }
  return null;
}

function when(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

export function recentTalk({
  events,
  roster,
  now,
  replaying,
}: {
  events: SequencedEntry[];
  roster: Member[];
  now: number;
  replaying: boolean;
}): TalkLine[] {
  if (replaying) return [];

  const lines: TalkLine[] = [];
  for (const { event } of events) {
    const type = event.draft.type;
    if (type !== "agent.message" && type !== "agent.tool.start") continue;

    const p = event.draft.payload as unknown as Record<string, unknown>;
    const from = typeof p.agentId === "string" ? p.agentId : null;
    if (!from) continue;

    const at = when(event.ts);
    if (at === null || now - at > WINDOW_MS || at > now + 1000) continue;

    if (type === "agent.tool.start") {
      if (p.tool !== "send_message") continue;
      const input = p.input as { to?: unknown } | undefined;
      // A `send_message` with no recipient is a real thing on the log — the
      // model left the field out — and there is nobody to draw a line to.
      if (typeof input?.to !== "string") continue;
      const to = resolveName(input.to, roster);
      if (!to || to === from) continue;
      lines.push({ id: event.id, from, to, kind: "agent", at });
      continue;
    }

    const to = p.to as { kind?: unknown } | undefined;
    // Only the two that genuinely appear here. An `agent` kind would be a
    // second answer to the question the tool call already answers (§2.1).
    if (to?.kind !== "user" && to?.kind !== "broadcast") continue;
    lines.push({ id: event.id, from, to: null, kind: to.kind, at });
  }
  return lines;
}

/** How far along its life a line is, 0 (just said) to 1 (about to go). Used to
 *  fade it out, so it leaves rather than blinking off. */
export function ageOf(line: TalkLine, now: number): number {
  return Math.min(1, Math.max(0, (now - line.at) / WINDOW_MS));
}
