/**
 * The room in a window of its own.
 *
 * The scene shares a column with the transcript, and the two want different
 * shapes: the transcript wants height and the room wants width. Popping the
 * room out gives each the whole of a window, and lets the room sit on a
 * second screen while the run is read on the first.
 *
 * **Two ways out, one page.** In the app the Rust side builds a second
 * webview with the same backend handshake the first one got — the token is
 * injected before any script runs, the same way, so the second window is a
 * second client of the same backend and nothing on the page knows the
 * difference. In a browser it is `window.open` on the same origin, where the
 * Vite plugin injects the handshake into every page it serves. Either way the
 * window loads the app with one extra fact — which mission — and `App` reads
 * that and renders the room alone.
 *
 * **While it is out, it is not in.** The main window's scene pane stands
 * down for that mission — two rooms for one run would be two renderers to
 * keep in step — and comes back the moment the other window closes, which
 * this store learns from the Rust side (an event on the window's death) or,
 * in a browser, by asking the handle.
 */
import { create } from "zustand";

const SCENE_PARAM = "scene";

declare global {
  interface Window {
    /** Set by the Rust side on a popped-out window: the mission it shows. */
    __AGENT_STUDIO_SCENE__?: string;
  }
}

/** Whether this page is the desktop shell rather than a browser tab. Exported
 *  so nothing else has to keep a second copy of the test (§2.1). */
export function inTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

/** The mission this window exists to show, or null for the ordinary shell. */
export function sceneWindowMission(): string | null {
  if (typeof window === "undefined") return null;
  const injected = window.__AGENT_STUDIO_SCENE__;
  if (typeof injected === "string" && injected) return injected;
  try {
    return new URLSearchParams(window.location.search).get(SCENE_PARAM);
  } catch {
    return null;
  }
}

interface PopoutState {
  /** The mission whose room is in its own window right now, if any. */
  openFor: string | null;
  open: (missionId: string) => Promise<void>;
  /** Bring the room back: close the other window. */
  close: () => Promise<void>;
}

//: The browser's handle on the window it opened, so it can be closed and
//: watched. Not in the store: a `Window` is not state.
let handle: Window | null = null;
let watcher: number | null = null;
let listening = false;

export const usePopoutStore = create<PopoutState>((set, get) => ({
  openFor: null,

  open: async (missionId) => {
    if (inTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      if (!listening) {
        // Told once, by the Rust side, when a room window closes — by its
        // own close button, or by `close` below. Not polled: a native window
        // has no `closed` flag a page can read.
        listening = true;
        const { listen } = await import("@tauri-apps/api/event");
        await listen<string>("scene-window-closed", (event) => {
          if (get().openFor === event.payload) set({ openFor: null });
        });
      }
      await invoke("open_scene_window", { missionId });
      set({ openFor: missionId });
      return;
    }

    const url = new URL(window.location.href);
    url.search = `?${SCENE_PARAM}=${encodeURIComponent(missionId)}`;
    // Named per mission, so a second click focuses the window it already
    // opened rather than stacking another.
    handle = window.open(url.toString(), `scene-${missionId}`, "popup,width=960,height=640");
    if (!handle) return;
    set({ openFor: missionId });
    if (watcher !== null) window.clearInterval(watcher);
    watcher = window.setInterval(() => {
      if (handle && !handle.closed) return;
      if (watcher !== null) window.clearInterval(watcher);
      watcher = null;
      handle = null;
      set({ openFor: null });
    }, 500);
  },

  close: async () => {
    const missionId = get().openFor;
    if (!missionId) return;
    if (inTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("close_scene_window", { missionId });
      // The Rust side's closed event clears `openFor`; cleared here too so
      // the pane comes back on the click rather than on the round trip.
      set({ openFor: null });
      return;
    }
    handle?.close();
    handle = null;
    set({ openFor: null });
  },
}));

/** Open the room for a mission in its own window. */
export function popOutScene(missionId: string): Promise<void> {
  return usePopoutStore.getState().open(missionId);
}

/**
 * From inside the popped-out window: put the room back, which is to say
 * close this window. The main window learns of it the same way it learns of
 * the close button — the Rust side's event, or the browser handle's flag.
 */
export async function closeThisSceneWindow(): Promise<void> {
  if (inTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  }
  window.close();
}
