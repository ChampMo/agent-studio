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
import { DEFAULT_POSE, poseFor, type AgentPose } from "../animation/poses";

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
}

export interface SceneState {
  actors: Actor[];
  /** Null while a mission runs; the reason once it has ended. */
  endReason: string | null;
  /** Seat count comes from the layout; the scene arranges that many desks. */
  seats: number;
}

interface Options {
  roster: SnapshotMember[];
  events: { event: EventEnvelope }[];
  seats: number;
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

export function deriveSceneState({ roster, events, seats }: Options): SceneState {
  const assignments = taskSeats(events);
  const bySeat = new Map(roster.map((m) => [m.seat_index, m]));

  const poses = new Map<string, AgentPose>();
  const tasks = new Map<string, string>();
  let endReason: string | null = null;

  for (const { event } of events) {
    const p = event.draft.payload as Record<string, any>;

    switch (event.draft.type) {
      case "agent.status":
        // Never indexed blindly: a status this build has never heard of becomes
        // the default pose rather than an undefined lookup (§8).
        poses.set(String(p.agentId), poseFor(p.status));
        break;

      case "mission.progress": {
        const owner = bySeat.get(assignments.get(String(p.label ?? "")) ?? -1);
        if (!owner) break;
        if (p.state === "running") tasks.set(owner.agent_id, String(p.label ?? ""));
        else tasks.delete(owner.agent_id);
        break;
      }

      case "mission.ended":
        endReason = String(p.reason ?? "unknown");
        break;
    }
  }

  const ended = endReason !== null;

  return {
    endReason,
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
    })),
  };
}
