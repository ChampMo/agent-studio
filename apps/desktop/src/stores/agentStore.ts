/**
 * The roster.
 *
 * Note the asymmetry with generation: a draft profile lives in component state
 * until the user saves it. §11 requires the profile be shown for editing and
 * never written automatically, so there is deliberately no "generated agent" in
 * this store — nothing here exists that is not in the database.
 */
import { create } from "zustand";
import { api, type Agent, type AgentInput } from "../transport/rest";

interface AgentState {
  agents: Agent[];
  assets: Record<string, string[]>;
  loading: boolean;
  error: string | null;
  showArchived: boolean;

  load: () => Promise<void>;
  setShowArchived: (value: boolean) => Promise<void>;
  create: (input: AgentInput) => Promise<Agent>;
  update: (id: string, changes: Partial<AgentInput>) => Promise<Agent>;
  duplicate: (id: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  /** Permanent. Replays are unaffected; the agent's team seats are not. */
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  assets: {},
  loading: false,
  error: null,
  showArchived: false,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [{ agents }, { slots }] = await Promise.all([
        api.listAgents(get().showArchived),
        api.avatarAssets(),
      ]);
      set({ agents, assets: slots });
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
    const agent = await api.createAgent(input);
    await get().load();
    return agent;
  },

  update: async (id, changes) => {
    const agent = await api.updateAgent(id, changes);
    await get().load();
    return agent;
  },

  duplicate: async (id) => {
    await api.duplicateAgent(id);
    await get().load();
  },

  archive: async (id) => {
    await api.archiveAgent(id);
    await get().load();
  },

  remove: async (id) => {
    await api.deleteAgent(id);
    await get().load();
  },

  restore: async (id) => {
    await api.restoreAgent(id);
    await get().load();
  },
}));
