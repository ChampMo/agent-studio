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
import type { SnapshotMember, } from "../../stores/missionStore";
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
  /** Slots from the closed catalogue: body, hair, outfit, palette (§11). */
  avatar: Record<string, string>;
  /** The task this character is on, when the plan named one. */
  task: string | null;
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

export interface SceneState {
  actors: Actor[];
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

/** `1. Gather sources → seat 2` — the plan's own line format. */
const PLAN_LINE = /^\s*\d+\.\s*(.+?)\s*(?:→|->)\s*seat\s*(\d+)\s*$/;

/**
 * Which seat each task went to, read out of the plan the leader broadcast.
 *
 * That message is the only record of the assignment — the progress events carry
 * a label and a state but not an owner — so the mapping is recovered from the
 * same event stream rather than fetched from anywhere else (§2.1).
 */
function taskSeats(events: { event: EventEnvelope }[]): Map<string, number> {
  const seats = new Map<string, number>();
  for (const { event } of events) {
    if (event.draft.type !== "agent.message") continue;
    const content = String((event.draft.payload as any).content ?? "");
    for (const line of content.split("\n")) {
      const match = PLAN_LINE.exec(line);
      if (match) seats.set(match[1]!, Number(match[2]));
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
  const assignments = taskSeats(events);
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

  for (const { event } of events) {
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
        break;
      }

      case "agent.message":
        // Only the latest speaker keeps a bubble. It clears itself when someone
        // else answers, which is also what happens in a room.
        speaker = String(p.agentId ?? "") || null;
        spoken = bubble(String(p.content ?? ""));
        break;

      case "agent.request":
        asking = String(p.agentId ?? "") || null;
        break;

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
      task: ended ? null : (tasks.get(member.agent_id) ?? null),
      place: member.agent_id === focusAgentId ? "floor" : "seat",
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
