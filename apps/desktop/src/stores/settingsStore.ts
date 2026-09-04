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
  type ModelPreset,
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
  /** Starting points for adding a model endpoint, from the backend so the UI
   *  never has to remember a base URL (§3.2). */
  modelPresets: ModelPreset[];
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
  /** Move a search key up or down the fallback chain. */
  moveSearchKey: (id: string, by: -1 | 1) => Promise<void>;
  setKey: (id: string, key: string) => Promise<void>;
  test: (id: string) => Promise<ProbeResult>;
}

/**
 * The endpoints something can actually be generated against.
 *
 * One function, because this question had grown **four** answers — the default
 * endpoint, the onboarding gate, the team advisor's dropdown and the agent
 * creator's — and they did not agree. The creator's was
 * `providers.filter((p) => p.hasKey)`, which got both halves wrong: it offered
 * Tavily and Brave, which cannot complete anything and fail with
 * `no provider registered for 'search'`, and it hid a local Ollama or LM
 * Studio, which authenticates nothing and so has no key to have.
 *
 * Both halves are already written down elsewhere in this file, correctly, one
 * on top of the other. That is the §2.1 shape exactly: two readers of one idea,
 * and the one nobody was looking at was the wrong one.
 *
 * `hasKey || verifiedAt` — you supplied a key, or the endpoint answered without
 * one. Both are established facts rather than a guess about which endpoints
 * need what.
 */
export function chatProviders(providers: ProviderProfile[]): ProviderProfile[] {
  return providers.filter(
    (p) => p.kind !== "search" && (p.hasKey || p.verifiedAt !== null),
  );
}

/** The default model endpoint: still present, and not a search key.
 *
 *  A stored id is re-checked rather than trusted, because a profile can be
 *  deleted, and because a machine that ran the older version has a search
 *  profile saved here. */
export function pickActive(
  providers: ProviderProfile[],
  current: string | null,
): string | null {
  const models = providers.filter((p) => p.kind !== "search");
  if (current && models.some((p) => p.id === current)) return current;
  // A usable one first; failing that, any model endpoint at all, so the
  // dropdown has something selected while it is still being set up.
  return chatProviders(providers)[0]?.id ?? models[0]?.id ?? null;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ready: false,
  loading: false,
  error: null,
  providers: [],
  searchEngines: [],
  modelPresets: [],
  activeId: null,
  probe: {},
  probing: null,

  // A search endpoint is not something to run a mission on, so it does not
  // count towards having a provider: an app with only a Brave key still needs
  // a model before anything can happen (§3.2).
  //
  // `hasKey || verifiedAt`, not `hasKey` alone. A server on this machine wants
  // no key, so the old rule left anyone running Ollama stuck on the onboarding
  // screen for ever with a working endpoint already configured. Both halves are
  // established facts — you supplied a key, or the endpoint answered — rather
  // than a guess about which endpoints need one.
  needsOnboarding: () => chatProviders(get().providers).length === 0,
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
      const { providers, searchEngines, modelPresets } = await api.listProviders();
      set((s) => ({
        providers,
        searchEngines: searchEngines ?? [],
        modelPresets: modelPresets ?? [],
        // The endpoint a new agent thinks with — which a search key is not.
        // `find((p) => p.hasKey)` chose the first key of any kind, and on a
        // machine whose Tavily key was added before its model key that is a
        // search profile: every "generate a profile" defaulted to an endpoint
        // that cannot complete anything, and failed with `no provider
        // registered for 'search'`. The line above already draws this
        // distinction for onboarding; this one did not.
        activeId: pickActive(providers, s.activeId),
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

  moveSearchKey: async (id, by) => {
    // Built here rather than in the component, because the chain is a property
    // of the whole list and the component only ever holds one row's id. The
    // backend takes the finished order and refuses anything that is not a
    // permutation of what it has.
    const chain = get().providers.filter((p) => p.kind === "search").map((p) => p.id);
    const from = chain.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= chain.length) return;
    [chain[from], chain[to]] = [chain[to]!, chain[from]!];
    await api.setSearchOrder(chain);
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
