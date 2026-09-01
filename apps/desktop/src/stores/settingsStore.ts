/**
 * Provider profiles and backend readiness.
 *
 * Note what this store never holds: an API key. It knows only `hasKey`, because
 * the backend has no endpoint that returns one (PROJECT_BRIEF.md §9.2).
 */
import { create } from "zustand";
import { getHandshake } from "../transport/handshake";
import {
  api,
  type ProbeResult,
  type ProviderProfile,
  type SearchEngine,
} from "../transport/rest";

interface SettingsState {
  ready: boolean;
  loading: boolean;
  error: string | null;
  providers: ProviderProfile[];
  /** The search APIs this build can talk to, served by the backend so the UI
   *  never has to remember a base URL (§16.5). */
  searchEngines: SearchEngine[];
  activeId: string | null;
  probe: Record<string, ProbeResult>;
  probing: string | null;

  /** True when no provider has a key: onboarding is mandatory then (§3.2). */
  needsOnboarding: () => boolean;
  active: () => ProviderProfile | null;

  refresh: () => Promise<void>;
  waitForBackend: () => Promise<void>;
  setActive: (id: string) => void;
  createProvider: (input: {
    name: string;
    kind: string;
    model: string;
    base_url?: string | null;
    key: string;
  }) => Promise<ProviderProfile>;
  removeProvider: (id: string) => Promise<void>;
  setNativeSearch: (id: string, on: boolean) => Promise<void>;
  setKey: (id: string, key: string) => Promise<void>;
  test: (id: string) => Promise<ProbeResult>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ready: false,
  loading: false,
  error: null,
  providers: [],
  searchEngines: [],
  activeId: null,
  probe: {},
  probing: null,

  // A search endpoint is not something to run a mission on, so it does not
  // count towards having a provider: an app with only a Brave key still needs
  // a model before anything can happen (§3.2).
  needsOnboarding: () =>
    get().providers.every((p) => !p.hasKey || p.kind === "search"),
  active: () => get().providers.find((p) => p.id === get().activeId) ?? null,

  waitForBackend: async () => {
    // Vite can serve the page before the backend has written its handshake, so
    // "not ready" is a normal startup state rather than an error (§4.2).
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (getHandshake()) {
        try {
          await api.health();
          set({ ready: true });
          await get().refresh();
          return;
        } catch {
          // Backend is still coming up.
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    set({ error: "backend did not become ready" });
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const { providers, searchEngines } = await api.listProviders();
      set((s) => ({
        providers,
        searchEngines: searchEngines ?? [],
        activeId:
          s.activeId && providers.some((p) => p.id === s.activeId)
            ? s.activeId
            : (providers.find((p) => p.hasKey)?.id ?? providers[0]?.id ?? null),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loading: false });
    }
  },

  setActive: (id) => set({ activeId: id }),

  createProvider: async ({ key, ...profile }) => {
    const created = await api.createProvider(profile);
    // Key second: a profile with no key is a recoverable state the UI can show,
    // whereas a key stored against a profile that failed to save is orphaned.
    await api.setKey(created.id, key);
    await get().refresh();
    set({ activeId: created.id });
    return created;
  },

  removeProvider: async (id) => {
    await api.deleteProvider(id);
    await get().refresh();
  },

  setNativeSearch: async (id, on) => {
    // The backend refuses this on an endpoint that cannot do it, so a failure
    // here is a real answer rather than something to paper over (§16.8).
    await api.updateProvider(id, { native_search: on });
    await get().refresh();
  },

  setKey: async (id, key) => {
    await api.setKey(id, key);
    await get().refresh();
  },

  test: async (id) => {
    set({ probing: id });
    try {
      const result = await api.testConnection(id);
      set((s) => ({ probe: { ...s.probe, [id]: result } }));
      await get().refresh();
      return result;
    } finally {
      set({ probing: null });
    }
  },
}));
