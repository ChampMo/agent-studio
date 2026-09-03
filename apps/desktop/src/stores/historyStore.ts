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
  /** Re-read the file list for a run that is producing them as you watch.
   *  `openMission` fetches once, which is right for a finished run and leaves
   *  a live one showing "Files 0" over a folder it has just written to. */
  refreshArtifacts: (missionId: string) => Promise<void>;
  openArtifact: (artifactId: string) => Promise<void>;
  /** Delete a whole run, with its events and files (§2, §5). */
  remove: (missionId: string) => Promise<void>;
  closeArtifact: () => void;
  /** Nothing is open. Called when a new run is started from the sidebar, so no
   *  past row goes on claiming to be the one on screen. */
  closeMission: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
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

      // A run the backend is *still driving* is not history, and replaying it
      // would hand back a snapshot that never updates while the header says
      // "Working" over a live Stop button. Worse, `observe()` ignores replayed
      // events on purpose, so a mission paused on a question would sit there
      // with no modal and no way to answer it.
      //
      // `attach` covers both halves: it subscribes from seq 0, so the history
      // arrives first and the run then continues live in the same stream.
      if (useMissionStore.getState().live) {
        useEventStore.getState().attach(missionId);
      } else {
        await useEventStore.getState().replay(missionId);
      }

      const { artifacts } = await api.missionArtifacts(missionId);
      set({ artifacts });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  refreshArtifacts: async (missionId) => {
    try {
      const { artifacts } = await api.missionArtifacts(missionId);
      set({ artifacts });
    } catch {
      // A count that fails to refresh is not worth an error in front of a
      // running mission; the next artifact event tries again.
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

  remove: async (missionId) => {
    try {
      await api.deleteMission(missionId);
    } catch (err) {
      set({ error: (err as Error).message });
      return;
    }
    // If the deleted run was the one on screen, stop showing its replay: the
    // events it was built from are gone.
    if (get().openId === missionId) {
      set({ openId: null, artifacts: [], open: null });
      useEventStore.getState().reset();
      useMissionStore.getState().clear();
    }
    await get().load();
  },

  closeArtifact: () => set({ open: null }),

  closeMission: () => {
    set({ openId: null, artifacts: [], open: null, error: null });
    useEventStore.getState().reset();
    useMissionStore.getState().clear();
  },
}));
