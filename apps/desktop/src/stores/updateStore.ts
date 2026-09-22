/**
 * Updating the app in place, instead of downloading an installer again.
 *
 * **What makes this safe is a signature, not a URL.** The updater fetches a
 * bundle and verifies it against the public key compiled into the app
 * (`plugins.updater.pubkey` in `tauri.conf.json`) before a byte is written. So
 * an update comes from whoever holds the matching private key or it does not
 * happen — a compromised endpoint can serve anything it likes and the app will
 * refuse all of it. The endpoint itself is only where the announcement lives.
 *
 * **The check is the one thing this app does over the network on its own.**
 * Everything else here goes to a model endpoint the user configured, or to
 * `127.0.0.1`. One request to GitHub per launch is the price of the app being
 * able to tell you it is out of date, and Settings says so in those words
 * rather than leaving it to be discovered in a packet capture.
 *
 * **Nothing installs without being asked.** Checking is automatic; downloading
 * and installing are a button. An app that replaces itself while somebody is
 * mid-run would be taking a decision that costs them the run.
 *
 * **The progress here is real**, unlike the generator's elapsed-seconds
 * counter: the download reports a content length and then chunk sizes, so a
 * proportional bar is a measurement. When the server sends no length there is
 * no proportion to draw, and the panel says how much has arrived instead of
 * inventing a denominator (§1.1).
 *
 * **The backend goes down with it.** On Windows the installer replaces the
 * running image, which ends this process — and the sidecar shuts itself down
 * when its stdin reaches EOF, which is exactly what a dead parent produces.
 * That contract was written for the app being killed and it covers this too.
 */
import { create } from "zustand";

import { inTauri } from "../lib/popout";

export type UpdateStage =
  /** Not asked yet. */
  | "unknown"
  /** A browser, or a build with no updater configured. Nothing to offer. */
  | "unsupported"
  | "checking"
  /** Asked, and this is the newest there is. */
  | "current"
  | "available"
  | "downloading"
  /** Installed. The app has to restart to be running it. */
  | "ready"
  /** The check or the download did not finish. `error` is why. */
  | "failed";

interface UpdateState {
  stage: UpdateStage;
  /** What this copy is. Read from the bundle, not from package.json. */
  installed: string | null;
  /** The version being offered, when there is one. */
  offered: string | null;
  /** The release notes the endpoint carried, verbatim. */
  notes: string | null;
  /** When the endpoint says it was published. Null when it did not say. */
  published: string | null;
  /** Bytes in so far, and the total **only if the server declared one**. */
  received: number;
  total: number | null;
  error: string | null;
  /** When this client last got an answer, for a panel that must not imply
   *  it is watching continuously. */
  checkedAt: number | null;

  /** Ask the endpoint. Safe to call when there is no updater — it reports
   *  `unsupported` rather than throwing. */
  check: (manual?: boolean) => Promise<void>;
  /** Fetch it, verify it, install it. Ends in `ready` or `failed`. */
  install: () => Promise<void>;
  /** Start the new copy. */
  restart: () => Promise<void>;
}

//: The `Update` handle the check returned. Not state: it is a live object with
//: methods, and putting one in a store makes every subscriber re-render when
//: nothing about it has changed.
let pending: { downloadAndInstall: (cb: (e: unknown) => void) => Promise<void> } | null =
  null;

/** What the Rust side reports while a download runs. */
type Progress =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  stage: "unknown",
  installed: null,
  offered: null,
  notes: null,
  published: null,
  received: 0,
  total: null,
  error: null,
  checkedAt: null,

  check: async (manual = false) => {
    if (!inTauri()) {
      set({ stage: "unsupported" });
      return;
    }
    // A second automatic check on top of one already running would ask twice
    // and keep the later answer, which is a race for no benefit. A manual
    // press is a person asking again and is allowed through.
    if (!manual && get().stage === "checking") return;

    set({ stage: "checking", error: null });
    try {
      const [{ check }, { getVersion }] = await Promise.all([
        import("@tauri-apps/plugin-updater"),
        import("@tauri-apps/api/app"),
      ]);
      const installed = await getVersion();
      const update = await check();
      pending = update;
      if (!update) {
        set({
          stage: "current",
          installed,
          offered: null,
          notes: null,
          published: null,
          checkedAt: Date.now(),
        });
        return;
      }
      set({
        stage: "available",
        // The updater's own idea of what is running, which is the number the
        // comparison was actually made against.
        installed: update.currentVersion ?? installed,
        offered: update.version,
        // Whatever the release said, unedited. This app does not summarise
        // somebody else's release notes.
        notes: update.body ?? null,
        published: update.date ?? null,
        received: 0,
        total: null,
        checkedAt: Date.now(),
      });
    } catch (err) {
      // Offline, rate-limited, no release yet, endpoint unreachable — all of
      // them arrive here and all of them are the endpoint's or the network's
      // words. Not flattened: "404" and "signature mismatch" are very
      // different pieces of news.
      set({ stage: "failed", error: message(err), checkedAt: Date.now() });
    }
  },

  install: async () => {
    const update = pending;
    if (!update) return;
    set({ stage: "downloading", received: 0, total: null, error: null });
    try {
      await update.downloadAndInstall((raw) => {
        const event = raw as Progress;
        if (event.event === "Started") {
          // Undefined when the server sent no content length, and then it
          // stays null: a bar needs a denominator and inventing one would be
          // drawing a proportion nobody measured.
          set({ total: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          set((s) => ({ received: s.received + event.data.chunkLength }));
        }
      });
      set({ stage: "ready" });
    } catch (err) {
      set({ stage: "failed", error: message(err) });
    }
  },

  restart: async () => {
    if (!inTauri()) return;
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
}));
