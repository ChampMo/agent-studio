/**
 * The mission currently on screen, and the roster it froze at launch.
 *
 * The roster comes from `missions.roster_snapshot`, never from the agents
 * table. That is the whole point of §5.1: a mission from last week must show
 * the names, models and avatars that actually did the work, even after the
 * agents have been renamed, re-modelled or archived since.
 */
import { create } from "zustand";
import { api, type Team } from "../transport/rest";
import { useEventStore } from "./eventStore";

export interface SnapshotMember {
  agent_id: string;
  name: string;
  seat_index: number;
  role_in_team: string;
  model: string | null;
  avatar_config: Record<string, string>;
  title?: string;
  role?: string;
}

interface MissionState {
  missionId: string | null;
  goal: string;
  roster: SnapshotMember[];
  endReason: string | null;
  launching: boolean;
  /** Every blocking finding from a refused launch, not just the first (§5.2). */
  rejected: string[] | null;

  launch: (team: Team, goal: string, requireApproval?: boolean) => Promise<void>;
  loadMission: (missionId: string) => Promise<void>;
  nameOf: (agentId: string) => string;
  clear: () => void;
}

export const useMissionStore = create<MissionState>((set, get) => ({
  missionId: null,
  goal: "",
  roster: [],
  endReason: null,
  launching: false,
  rejected: null,

  launch: async (team, goal, requireApproval = false) => {
    set({ launching: true, rejected: null });
    try {
      const { missionId } = await api.startMission({
        team_id: team.id,
        content: goal,
        require_approval: requireApproval,
      });
      // Subscribe from 0: mission.started and user.message were published
      // before this response landed, and the replay covers them.
      useEventStore.getState().attach(missionId);
      set({ missionId, goal, endReason: null });
      await get().loadMission(missionId);
    } catch (err) {
      const detail = (err as { message?: string })?.message;
      let problems: string[] = [detail ?? String(err)];
      try {
        const parsed = JSON.parse(detail ?? "");
        if (Array.isArray(parsed?.problems)) problems = parsed.problems;
      } catch {
        // A plain string message is fine; keep it as the single problem.
      }
      set({ rejected: problems });
    } finally {
      set({ launching: false });
    }
  },

  loadMission: async (missionId) => {
    const mission = (await api.getMission(missionId)) as Record<string, unknown>;
    set({
      missionId,
      goal: String(mission.goal ?? ""),
      roster: (mission.rosterSnapshot as SnapshotMember[]) ?? [],
      endReason: (mission.endReason as string | null) ?? null,
    });
  },

  nameOf: (agentId) =>
    get().roster.find((m) => m.agent_id === agentId)?.name ?? agentId,

  clear: () => set({ missionId: null, goal: "", roster: [], rejected: null }),
}));
