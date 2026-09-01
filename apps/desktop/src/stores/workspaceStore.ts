/**
 * The folder a mission may touch (PROJECT_BRIEF.md §16.2).
 *
 * Chosen here, validated on the backend, and shown for as long as the mission
 * runs. That last part is not decoration: the agent can write files, and a user
 * who cannot see where is being asked to trust something they cannot check (§1).
 *
 * Nothing in this store decides whether a path is allowed. It asks. The window
 * can be driven by a page, so the only useful place for that answer is the
 * process that will act on it.
 */
import { create } from "zustand";
import { api, type RecentWorkspace, type WorkspaceCheck } from "../transport/rest";

interface WorkspaceState {
  /** The resolved path, as the backend returned it. */
  chosen: WorkspaceCheck | null;
  recent: RecentWorkspace[];
  checking: boolean;
  /** Why the last choice was refused. Cleared by the next attempt. */
  error: string | null;

  loadRecent: () => Promise<void>;
  /** Ask the OS for a folder. Falls back to a typed path in the browser. */
  pick: () => Promise<void>;
  choose: (path: string) => Promise<void>;
  clear: () => void;
}

/**
 * The Tauri folder picker, when there is one.
 *
 * In `npm run dev` the frontend is an ordinary page with no Tauri API, so this
 * resolves to null and the panel offers a text field instead. One code path for
 * both would mean either no picker in the app or no workspace in the browser.
 */
async function pickDirectory(): Promise<string | null> {
  if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Choose a workspace folder" });
  return typeof picked === "string" ? picked : null;
}

export const canPickDirectory = (): boolean =>
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  chosen: null,
  recent: [],
  checking: false,
  error: null,

  loadRecent: async () => {
    try {
      const { workspaces } = await api.recentWorkspaces();
      set({ recent: workspaces });
    } catch {
      // A picker without its history is still a picker.
      set({ recent: [] });
    }
  },

  pick: async () => {
    const picked = await pickDirectory();
    if (picked) await get().choose(picked);
  },

  choose: async (path) => {
    set({ checking: true, error: null });
    try {
      // Every time, including for a folder picked out of the recent list:
      // having passed once is not a permission, and a folder can stop being a
      // reasonable place to write between two launches (§16.2).
      const checked = await api.validateWorkspace(path);
      set({ chosen: checked });
    } catch (err) {
      set({ chosen: null, error: (err as Error).message });
    } finally {
      set({ checking: false });
    }
  },

  clear: () => set({ chosen: null, error: null }),
}));
