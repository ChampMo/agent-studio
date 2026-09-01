/**
 * The tool registry, as the backend serves it (PROJECT_BRIEF.md §16.1).
 *
 * Fetched, never copied. The frontend has no list of its own — which is the
 * whole point of §15 row 11: a second list drifts, and the drift shows up as a
 * tool the picker offers that the backend has never heard of.
 *
 * A tool missing from this list is a tool this machine cannot run. `web_search`
 * with no key configured simply is not here (§15 row 32).
 */
import { create } from "zustand";
import { api, type Tool } from "../transport/rest";

interface ToolState {
  tools: Tool[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useToolStore = create<ToolState>((set, get) => ({
  tools: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const { tools } = await api.listTools();
      set({ tools, loaded: true });
    } catch {
      // An empty registry is the honest fallback: the picker shows nothing
      // rather than a list this build made up.
      set({ tools: [], loaded: true });
    }
  },
}));
