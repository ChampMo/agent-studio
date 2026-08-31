/**
 * The team library.
 *
 * `findings` and `canRun` arrive with every team rather than being recomputed
 * here. The backend runs one validator and the run gate is defined as "no
 * error in that list" (§5.2) — a second opinion in the frontend is exactly the
 * drift decision row 13 exists to prevent.
 */
import { create } from "zustand";
import {
  api,
  type SceneLayout,
  type Team,
  type TeamExport,
  type TeamInput,
} from "../transport/rest";

interface TeamState {
  teams: Team[];
  layouts: SceneLayout[];
  loading: boolean;
  error: string | null;
  showArchived: boolean;
  /** Set after an import that matched a previous one, so the UI can say so. */
  lastImportDuplicateOf: string[] | null;

  load: () => Promise<void>;
  setShowArchived: (value: boolean) => Promise<void>;
  create: (input: TeamInput) => Promise<Team>;
  update: (id: string, changes: Partial<TeamInput>) => Promise<Team>;
  duplicate: (id: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  exportTeam: (id: string) => Promise<TeamExport>;
  importTeam: (document: TeamExport) => Promise<void>;
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  layouts: [],
  loading: false,
  error: null,
  showArchived: false,
  lastImportDuplicateOf: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [{ teams }, { layouts }] = await Promise.all([
        api.listTeams(get().showArchived),
        api.sceneLayouts(),
      ]);
      set({ teams, layouts });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loading: false });
    }
  },

  setShowArchived: async (showArchived) => {
    set({ showArchived });
    await get().load();
  },

  create: async (input) => {
    const team = await api.createTeam(input);
    await get().load();
    return team;
  },

  update: async (id, changes) => {
    const team = await api.updateTeam(id, changes);
    await get().load();
    return team;
  },

  duplicate: async (id) => {
    await api.duplicateTeam(id);
    await get().load();
  },

  archive: async (id) => {
    await api.archiveTeam(id);
    await get().load();
  },

  restore: async (id) => {
    await api.restoreTeam(id);
    await get().load();
  },

  exportTeam: (id) => api.exportTeam(id),

  importTeam: async (document) => {
    const result = await api.importTeam(document);
    set({
      lastImportDuplicateOf: result.alreadyImported.length
        ? result.alreadyImported
        : null,
    });
    await get().load();
  },
}));
