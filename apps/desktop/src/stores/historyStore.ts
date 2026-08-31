/**
 * Past missions, and what they produced (PROJECT_BRIEF.md §12 M6).
 *
 * Opening an old mission loads two things from the backend and nothing from
 * memory: the frozen roster (`missionStore.loadMission`) and the event log
 * (`eventStore.replay`). Both are what was recorded at the time, so a run from
 * last week shows the names, models and avatars that actually did the work even
 * after the agents have been renamed or archived since (§5.1).
 */
import { create } from "zustand";
import { api, type Artifact, type MissionSummary } from "../transport/rest";
import { useEventStore } from "./eventStore";
import { useMissionStore } from "./missionStore";

interface HistoryState {
  missions: MissionSummary[];
  loading: boolean;
  openId: string | null;
  artifacts: Artifact[];
  /** The artifact on screen, with its text. Fetched on demand: the list is
   *  metadata, and a mission can produce files nobody wants to read. */
  open: (Artifact & { text: string }) | null;
  error: string | null;

  load: () => Promise<void>;
  openMission: (missionId: string) => Promise<void>;
  openArtifact: (artifactId: string) => Promise<void>;
  closeArtifact: () => void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  missions: [],
  loading: false,
  openId: null,
  artifacts: [],
  open: null,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const { missions } = await api.listMissions();
      set({ missions });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  openMission: async (missionId) => {
    set({ openId: missionId, open: null, artifacts: [], error: null });
    try {
      // The roster first: the timeline names agents from it, and loading the
      // events first would briefly print raw ids.
      await useMissionStore.getState().loadMission(missionId);
      await useEventStore.getState().replay(missionId);
      const { artifacts } = await api.missionArtifacts(missionId);
      set({ artifacts });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  openArtifact: async (artifactId) => {
    try {
      set({ open: await api.readArtifact(artifactId) });
    } catch (err) {
      // 410 when the row outlived the file — said plainly rather than as a
      // blank viewer that looks like an empty document.
      set({ error: (err as Error).message });
    }
  },

  closeArtifact: () => set({ open: null }),
}));
