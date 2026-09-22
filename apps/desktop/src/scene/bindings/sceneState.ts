/**
 * event stream → scene state (PROJECT_BRIEF.md §4 `scene/bindings`, §2.1).
 *
 * The scene and the timeline consume the *same* events. This module is the
 * mapper the brief asks to be kept separate and obvious, and it is pure: given
 * a list of events and the mission's frozen roster it returns what to draw, and
 * the renderer does nothing but draw it.
 *
 * Pure for a reason. The M5 criterion — an unknown status falls back to the
 * default pose without crashing — is then a test, not something verified by
 * squinting at a canvas.
 *
 * Two rules that only look like details:
 *
 * * Characters come from `missions.roster_snapshot`, never the agents table, so
 *   a replay draws the avatars that actually did the work (§5.1).
 * * `mission.ended` resets everyone. A cancelled run never reaches `agent.status
 *   idle` — the runtime is closed mid-thought — so a scene waiting for one would
 *   leave a character thinking for ever.
 */
import type { EventEnvelope } from "../../transport/events.generated";
import type { SnapshotMember } from "../../stores/missionStore";
import type { StreamingMessage } from "../../stores/eventStore";
import { DEFAULT_POSE, poseFor, type AgentPose } from "../animation/poses";

/** How much of a message a bubble carries before it stops being readable. */
export const BUBBLE_LIMIT = 180;

export interface Actor {
  agentId: string;
  name: string;
  seatIndex: number;
  isLeader: boolean;
  pose: AgentPose;
  /** Slots from the closed catalogue: build, coat, outfit, palette (§11). */
  avatar: Record<string, string>;
  /** Their job, off the frozen snapshot. Shown where there is room for it. */
  title: string;
  /** What this member carried **on this run**, off the frozen snapshot — so
   *  the desk a replay draws is the desk that ran, not the one they would be
   *  given today (§5.1). Props are derived from it. */
  tools: string[];
  /** The task this character is on, when the plan named one. */
  task: string | null;
  /**
   * The tool this agent is using **right now**: an `agent.tool.start` whose
   * `callId` has not had its `agent.tool.end`. The raw tool id off the log,
   * so an id this build has never heard of passes through and the renderer
   * draws nothing for it rather than a guess (§8). Null at an idle desk.
   */
  activeTool: string | null;
  /**
   * Where the character stands (§12 M7).
   *
   * Not an animation: a *derived position*. Walking is how the renderer gets
   * from the old one to the new one, so a character on the move is always on
   * the way somewhere the event stream put them. `floor` means this agent is
   * the one the mission currently turns on — the one being waited on, or the
   * one whose task is running.
   */
  place: "seat" | "floor";
  /** The last thing this character said, if they are the one who spoke last.
   *  Their own words, cut at `BUBBLE_LIMIT` — never a paraphrase. */
  says: string | null;
}

/**
 * Something thrown across the room, because the log says one cat sent
 * something to another.
 *
 *   assign    the leader hands a task to its owner   (`mission.progress` pending)
 *   done      the owner sends it back finished       (`mission.progress` done)
 *   failed    the owner sends it back empty          (`mission.progress` failed)
 *   message   one teammate messages another          (`send_message`, or a note
 *                                                     from the person to one cat)
 *   request   a question for the person              (`agent.request`)
 *
 * `"front"` is where the person is — the near edge of the room. A throw is
 * a fact about *one moment*, so the renderer decides which are fresh; this
 * lists every one on the log, in order, keyed by seq.
 */
export interface Throw {
  seq: number;
  ts: string;
  kind: "assign" | "done" | "failed" | "message" | "request";
  from: string | "front";
  to: string | "front";
}

export interface SceneState {
  actors: Actor[];
  /** Everything that has been thrown, oldest first. */
  throws: Throw[];
  /** Who has the floor, if anyone. The camera follows this. */
  focusAgentId: string | null;
  /** Null while a mission runs; the reason once it has ended. */
  endReason: string | null;
  /** Seat count comes from the layout; the scene arranges that many desks. */
  seats: number;
}

interface Options {
  roster: SnapshotMember[];
  events: { event: EventEnvelope }[];
  seats: number;
  /**
   * Replies still being typed, by messageId (§7.1).
   *
   * Optional, and empty for a replay: deltas are never persisted, so a finished
   * mission has none. That is deliberate rather than a gap - everything else
   * here comes from the sequenced log, which is why a replay and a live run
   * derive the same scene. This is the one live-only flourish, and all it does
   * is show the same words a few seconds earlier than the message that carries
   * them.
   */
  streaming?: Record<string, StreamingMessage>;
}

/** A bubble carries what was said, shortened, never rewritten. */
function bubble(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length <= BUBBLE_LIMIT
    ? trimmed
    : `${trimmed.slice(0, BUBBLE_LIMIT).trimEnd()}…`;
}

/**
 * The teammate a typed name refers to, for the picture only: exact, then
 * prefix, then contains, and nobody when that is not unique — the same order
 * `Mailbox.resolve` uses on the backend, which is the answer that actually
 * decides where the message went. A name this cannot place throws nothing;
 * it never guesses.
 */
function whoIs(name: string, roster: SnapshotMember[]): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const names = roster.map((m) => ({ id: m.agent_id, n: (m.name ?? "").toLowerCase() }));
  for (const test of [
    (n: string) => n === key,
    (n: string) => n.startsWith(key),
    (n: string) => n.includes(key),
  ]) {
    const hits = names.filter((m) => test(m.n));
    if (hits.length === 1) return hits[0]!.id;
    if (hits.length > 1) return null;
  }
  return null;
}

/** The tool of the newest open call, or null when there is none. */
function newest(calls: { tool: string }[] | undefined): string | null {
  const last = calls?.[calls.length - 1];
  return last && last.tool ? last.tool : null;
}

/**
 * `1. Gather sources → Wren` — the plan's own line format.
 *
 * The backend writes the assignee **by name** (a person approving a plan has
 * no way to know who "seat 2" is) and used to write `→ seat 2`. This read
 * only the old form, so from the day the plan started naming people every
 * task quietly had no owner: no label under the cat, nobody walking to the
 * floor, nothing thrown when a task changed hands. Both forms are read.
 */
const PLAN_LINE = /^\s*\d+\.\s*(.+?)\s*(?:→|->)\s*(.+?)\s*$/;
const SEAT_WORD = /^seat\s*(\d+)$/i;

/**
 * Which seat each task went to, read out of the plan the leader broadcast.
 *
 * That message is the only record of the assignment — the progress events carry
 * a label and a state but not an owner — so the mapping is recovered from the
 * same event stream rather than fetched from anywhere else (§2.1).
 */
function taskSeats(
  events: { event: EventEnvelope }[],
  roster: SnapshotMember[],
): Map<string, number> {
  const seats = new Map<string, number>();
  const seatOf = (who: string): number | null => {
    const seat = SEAT_WORD.exec(who);
    if (seat) return Number(seat[1]);
    // The exact name the backend wrote, which is the roster's own. Not a
    // fuzzy match: this decides who gets the caption and the walk.
    const member = roster.find(
      (m) => (m.name ?? "").trim().toLowerCase() === who.toLowerCase(),
    );
    return member ? member.seat_index : null;
  };
  for (const { event } of events) {
    if (event.draft.type !== "agent.message") continue;
    const content = String((event.draft.payload as any).content ?? "");
    for (const line of content.split("\n")) {
      const match = PLAN_LINE.exec(line);
      if (!match) continue;
      const seat = seatOf(match[2]!.trim());
      if (seat !== null) seats.set(match[1]!, seat);
    }
  }
  return seats;
}

export function deriveSceneState({
  roster,
  events,
  seats,
  streaming = {},
}: Options): SceneState {
  const assignments = taskSeats(events, roster);
  const bySeat = new Map(roster.map((m) => [m.seat_index, m]));

  const poses = new Map<string, AgentPose>();
  const tasks = new Map<string, string>();
  let endReason: string | null = null;
  //: The agent an outstanding question is waiting on. Cleared by its answer -
  //: an unanswered request from a run that was cancelled must not hold the
  //: floor for ever in a replay.
  let asking: string | null = null;
  //: Whoever is on the task that is running right now.
  let onTask: string | null = null;
  let speaker: string | null = null;
  let spoken: string | null = null;
  //: Tool calls that have started and not ended, per agent, newest last. The
  //: desk shows the newest. Same rule as the transcript's pending spinner —
  //: and the same reset: a cancelled run leaves a dangling start that was
  //: true of the moment it was written, and a replay of it must not keep a
  //: dish turning over a finished record for ever.
  const open = new Map<string, { callId: string; tool: string }[]>();
  const throws: Throw[] = [];
  const leader = roster.find((m) => m.role_in_team === "leader")?.agent_id ?? null;
  const known = new Set(roster.map((m) => m.agent_id));
  //: The event being read, for the throws it produces.
  let at: EventEnvelope | null = null;
  const throwIt = (kind: Throw["kind"], from: string | null, to: string | null) => {
    // Both ends have to be somebody in this room. A throw from nobody to
    // nobody is a drawing of nothing.
    if (!at || !from || !to || from === to) return;
    if (from !== "front" && !known.has(from)) return;
    if (to !== "front" && !known.has(to)) return;
    throws.push({ seq: at.seq, ts: at.ts, kind, from, to });
  };

  for (const { event } of events) {
    at = event;
    const p = event.draft.payload as Record<string, any>;

    // The first event after a round ended opens the next one, and the room is
    // cleared for it. `mission.ended` is the end of a *round*, not of the log:
    // a continued run appends to the same events, so without this the scene
    // went on captioning `round finished — crashed` over a team that was
    // three tasks into its next round, with everyone still sat down.
    //
    // Exactly the half `deriveVitals` was already given for its counters. Two
    // places derive per-round state from one log, and both need the rule.
    if (endReason !== null && event.draft.type !== "mission.ended") {
      endReason = null;
      poses.clear();
      tasks.clear();
      asking = null;
      onTask = null;
      speaker = null;
      spoken = null;
      open.clear();
    }

    switch (event.draft.type) {
      case "agent.status":
        // Never indexed blindly: a status this build has never heard of becomes
        // the default pose rather than an undefined lookup (§8).
        poses.set(String(p.agentId), poseFor(p.status));
        break;

      case "mission.progress": {
        const owner = bySeat.get(assignments.get(String(p.label ?? "")) ?? -1);
        if (!owner) break;
        if (p.state === "running") {
          tasks.set(owner.agent_id, String(p.label ?? ""));
          onTask = owner.agent_id;
        } else {
          tasks.delete(owner.agent_id);
          if (onTask === owner.agent_id) onTask = null;
        }
        // The task changes hands: out from the leader when it is announced,
        // back to the leader when it comes back finished or empty.
        if (p.state === "pending") throwIt("assign", leader, owner.agent_id);
        if (p.state === "done") throwIt("done", owner.agent_id, leader);
        if (p.state === "failed") throwIt("failed", owner.agent_id, leader);
        break;
      }

      case "user.message":
        // A note to one teammate comes in from the front of the room. A
        // broadcast is for everyone and is thrown at nobody in particular.
        if (typeof p.to === "string" && p.to) throwIt("message", "front", String(p.to));
        break;

      case "agent.message":
        // Only the latest speaker keeps a bubble. It clears itself when someone
        // else answers, which is also what happens in a room.
        speaker = String(p.agentId ?? "") || null;
        spoken = bubble(String(p.content ?? ""));
        break;

      case "agent.request":
        asking = String(p.agentId ?? "") || null;
        throwIt("request", asking, "front");
        break;

      case "agent.tool.start": {
        const id = String(p.agentId ?? "");
        const calls = open.get(id) ?? [];
        calls.push({ callId: String(p.callId ?? ""), tool: String(p.tool ?? "") });
        open.set(id, calls);
        // A message to a teammate, thrown at whoever the name is — as the
        // backend would resolve it, and at nobody when it would not.
        if (p.tool === "send_message") {
          const input = (p.input ?? {}) as Record<string, unknown>;
          throwIt("message", id, whoIs(String(input.to ?? ""), roster));
        }
        break;
      }

      case "agent.tool.end": {
        // The end reaches back and closes its own start. An end with no start
        // — the start fell in the previous round — is simply nothing.
        const id = String(p.agentId ?? "");
        const callId = String(p.callId ?? "");
        open.set(id, (open.get(id) ?? []).filter((c) => c.callId !== callId));
        break;
      }

      case "agent.request.resolved":
        // The answer ends the wait, and the log says so. The asker published
        // `waiting` when it asked and publishes nothing when it stops - so
        // without this the leader stands captioned `waiting` for the rest of
        // the run, describing a question that was answered minutes ago.
        //
        // Derived, not invented: no synthetic `agent.status` is written
        // anywhere. A later real status still overrides this, because events
        // are read in order.
        if (asking) poses.delete(asking);
        asking = null;
        break;

      case "mission.ended":
        endReason = String(p.reason ?? "unknown");
        break;
    }
  }

  const ended = endReason !== null;

  // A question outranks a task: while someone is being waited on, they are what
  // the mission is about. Once it has ended everyone sits back down.
  const focusAgentId = ended ? null : (asking ?? onTask);

  // Deltas name their author, so a reply being typed becomes a bubble before
  // the message that carries it lands. Last one wins - the runtime streams one
  // reply at a time (§7.1).
  let typing: { agentId: string; text: string } | null = null;
  for (const partial of Object.values(streaming)) {
    if (partial.agentId) typing = partial;
  }

  return {
    endReason,
    focusAgentId,
    throws,
    seats: Math.max(seats, roster.length),
    actors: roster.map((member) => ({
      agentId: member.agent_id,
      name: member.name,
      seatIndex: member.seat_index,
      isLeader: member.role_in_team === "leader",
      // Once the mission is over nobody is working, whatever the last status
      // said. A cancelled run is closed before it can report `idle`.
      pose: ended ? DEFAULT_POSE : (poses.get(member.agent_id) ?? DEFAULT_POSE),
      avatar: member.avatar_config ?? {},
      title: member.title ?? "",
      tools: member.tools ?? [],
      task: ended ? null : (tasks.get(member.agent_id) ?? null),
      activeTool: ended ? null : newest(open.get(member.agent_id)),
      // Nobody leaves their seat any more. The walk to the front of the room
      // was M7's way of showing whose turn it was, and with the tool on the
      // desk and the things thrown between desks it had become a cat standing
      // in the middle of the room away from the very desk that showed what it
      // was doing. The camera still turns to them through `focusAgentId`, and
      // the compact view still rings them. `floor` stays in the type so a
      // renderer that wants the walk back has somewhere to read it from.
      place: "seat",
      says: ended
        ? null
        : typing?.agentId === member.agent_id
          ? bubble(typing.text)
          : speaker === member.agent_id
            ? spoken
            : null,
    })),
  };
}
