/**
 * The mission currently on screen, and the roster it froze at launch.
 *
 * The roster comes from `missions.roster_snapshot`, never from the agents
 * table. That is the whole point of §5.1: a mission from last week must show
 * the names, models and avatars that actually did the work, even after the
 * agents have been renamed, re-modelled or archived since.
 *
 * A run has two lives here. Before the first message it is a **draft**: a
 * title, a team and a folder, held in this window and nowhere else. Nothing has
 * been created, nothing is running, and closing the app loses it — which is
 * right, because a run nobody has said anything to is not a run yet. The first
 * message is what creates the mission; from then on the backend owns it.
 *
 * Naming a run before starting it is the point. Setting one up and deciding
 * what to ask are two different thoughts, and the old form made you have both
 * at once, in one textarea, before anything existed.
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
  /** What this member carried on this run. Frozen at launch like everything
   *  else in the snapshot, so the desk a replay draws is the desk that ran. */
  tools?: string[];
  title?: string;
  role?: string;
}

/** A run that has been set up and not yet said anything to. */
export interface Draft {
  title: string;
  teamId: string;
  workspaceRoot: string | null;
  requireApproval: boolean;
  /** Only the ceilings this run wants to differ on. Everything absent is
   *  inherited from the team and then the app, field by field (§10). */
  budget: Record<string, number>;
}

interface MissionState {
  missionId: string | null;
  /** What this run is called. Falls back to the goal for runs recorded before
   *  migration 0010, which had no title of their own. */
  title: string;
  goal: string;
  /** "chat" or "team". A chat is a mission with one seat (§15 row 4). */
  kind: string;
  /** Which team this run belongs to. Identity, not a record: the snapshot does
   *  not carry the team's *name*, so the breadcrumb resolves it from the live
   *  team list and a team renamed since shows its current name. Who did the
   *  work is the roster below, and that is frozen (§5.1). */
  teamId: string | null;
  roster: SnapshotMember[];
  endReason: string | null;
  /** Which ceiling ended it, when one did. */
  endLimit: string | null;
  /** The folder this mission's file tools may touch (§16.2). */
  workspaceRoot: string | null;
  /** The ceilings this run was launched with (§10). */
  budget: Record<string, number> | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Whether *this backend process* is still driving the run. A row from a
   *  previous launch is history even when its status still says `running`. */
  live: boolean;
  /** Set up, not yet started. Null once the mission exists. */
  draft: Draft | null;
  launching: boolean;
  /** Every blocking finding from a refused launch, not just the first (§5.2). */
  rejected: string[] | null;

  /** Set a run up without creating anything. */
  beginDraft: (draft: Draft) => void;
  /** The first message: this is what actually creates the mission. */
  sendFirst: (
    team: Team,
    message: string,
    opts?: { requireApproval?: boolean },
  ) => Promise<void>;
  /** Keep a finished run going, in the same conversation. */
  /** Rename the open run. The title only — `goal` is the record. */
  setTitle: (title: string) => void;
  continueRun: (
    message: string,
    opts?: { requireApproval?: boolean },
  ) => Promise<void>;
  /** Branch this run: same frozen roster, same workspace, a separate log.
   *  Opens the fork, because the point of forking is to watch the new one. */
  forkRun: (message: string) => Promise<void>;
  launch: (
    team: Team,
    goal: string,
    options?: {
      title?: string | null;
      requireApproval?: boolean;
      workspaceRoot?: string | null;
      budget?: Record<string, number>;
    },
  ) => Promise<void>;
  loadMission: (missionId: string) => Promise<void>;
  nameOf: (agentId: string) => string;
  avatarOf: (agentId: string) => Record<string, string> | null;
  clear: () => void;
}

export const useMissionStore = create<MissionState>((set, get) => ({
  missionId: null,
  title: "",
  goal: "",
  kind: "team",
  teamId: null,
  roster: [],
  endReason: null,
  endLimit: null,
  workspaceRoot: null,
  budget: null,
  startedAt: null,
  endedAt: null,
  live: false,
  draft: null,
  launching: false,
  rejected: null,

  beginDraft: (draft) => {
    // A draft replaces whatever was on screen, so the events of the previous
    // run must go with it or the new run opens showing someone else's log.
    useEventStore.getState().reset();
    set({
      draft,
      missionId: null,
      title: draft.title,
      goal: "",
      teamId: draft.teamId,
      workspaceRoot: draft.workspaceRoot,
      roster: [],
      endReason: null,
      rejected: null,
    });
  },

  sendFirst: async (team, message, opts = {}) => {
    const draft = get().draft;
    await get().launch(team, message, {
      title: draft?.title ?? null,
      // `/plan` asks for the gate on this send; the draft's checkbox asks for
      // it on every send. Either is a yes — neither can turn the other off,
      // because nobody types a command to get *less* of a safety check.
      requireApproval:
        opts.requireApproval || (draft?.requireApproval ?? false),
      workspaceRoot: draft?.workspaceRoot ?? get().workspaceRoot,
      budget: draft?.budget,
    });
  },

  setTitle: (title) => set({ title }),

  continueRun: async (message, opts = {}) => {
    const missionId = get().missionId;
    if (!missionId) return;
    set({ launching: true, rejected: null });
    try {
      await api.continueMission(missionId, message, opts);
      // Back on the stream from 0: the socket replays what is already there and
      // then carries the new round, so the transcript stays one conversation.
      useEventStore.getState().attach(missionId);
      set({ endReason: null, live: true });
      await get().loadMission(missionId);
    } catch (err) {
      set({
        rejected: [(err as { message?: string })?.message ?? String(err)],
      });
    } finally {
      set({ launching: false });
    }
  },

  forkRun: async (message) => {
    const from = get().missionId;
    if (!from) return;
    set({ launching: true, rejected: null });
    try {
      const { missionId } = await api.forkMission(from, message);
      // The original is left exactly as it is — that is the whole point — and
      // the window moves to the new one, because nobody forks a run in order
      // to keep watching the old one.
      useEventStore.getState().attach(missionId);
      set({ missionId, endReason: null, live: true });
      await get().loadMission(missionId);
    } catch (err) {
      set({
        rejected: [(err as { message?: string })?.message ?? String(err)],
      });
    } finally {
      set({ launching: false });
    }
  },

  launch: async (team, goal, options = {}) => {
    set({ launching: true, rejected: null });
    try {
      const { missionId } = await api.startMission({
        team_id: team.id,
        title: options.title ?? null,
        content: goal,
        require_approval: options.requireApproval ?? false,
        workspace_root: options.workspaceRoot ?? null,
        // Omitted entirely when nothing was overridden, so the backend falls
        // straight through to the team's limits and then the app's.
        ...(options.budget && Object.keys(options.budget).length > 0
          ? { budget: options.budget }
          : {}),
      });
      // Subscribe from 0: mission.started and user.message were published
      // before this response landed, and the replay covers them.
      useEventStore.getState().attach(missionId);
      set({
        missionId,
        goal,
        teamId: team.id,
        endReason: null,
        live: true,
        draft: null,
      });
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
    const mission = (await api.getMission(missionId)) as Record<
      string,
      unknown
    >;
    const goal = String(mission.goal ?? "");
    set({
      missionId,
      // A run from before 0010 has no title. Its goal is what it was called at
      // the time, so that is what it goes on being called (§5.1).
      title: (mission.title as string | null) || goal,
      goal,
      kind: String(mission.kind ?? "team"),
      teamId: (mission.teamId as string | null) ?? null,
      roster: (mission.rosterSnapshot as SnapshotMember[]) ?? [],
      endReason: (mission.endReason as string | null) ?? null,
      endLimit: (mission.endLimit as string | null) ?? null,
      workspaceRoot: (mission.workspaceRoot as string | null) ?? null,
      budget: (mission.budget as Record<string, number> | null) ?? null,
      startedAt: (mission.startedAt as string | null) ?? null,
      endedAt: (mission.endedAt as string | null) ?? null,
      live: mission.running === true,
      draft: null,
    });
  },

  nameOf: (agentId) =>
    get().roster.find((m) => m.agent_id === agentId)?.name ?? agentId,

  avatarOf: (agentId) =>
    get().roster.find((m) => m.agent_id === agentId)?.avatar_config ?? null,

  clear: () =>
    set({
      missionId: null,
      title: "",
      goal: "",
      teamId: null,
      roster: [],
      rejected: null,
      workspaceRoot: null,
      endReason: null,
      budget: null,
      startedAt: null,
      endedAt: null,
      live: false,
      draft: null,
    }),
}));
