/**
 * Showing a folder in the OS file manager (§16.2).
 *
 * The workspace path is on screen for as long as a run is open, because it is
 * the edge of what the agents may touch and that is only checkable if it is
 * visible. Opening it is the obvious next thing to want, and until now the only
 * way was to select the text and paste it somewhere else.
 *
 * **It works in the window and not in a browser**, which is the same split the
 * folder picker has: a page cannot open a directory on the machine, and no
 * amount of asking will change that. So the browser gets the next most useful
 * thing — the path on the clipboard — and the button says which of the two
 * happened rather than appearing to do nothing.
 *
 * The Rust side does the checking: the path must exist and must be a directory,
 * and it is canonicalised before it reaches the file manager. This side does not
 * validate, because a check here would be a check the caller could skip.
 */
import { strings } from "./constants/strings.en";

export type RevealOutcome =
  | { kind: "opened" }
  | { kind: "copied" }
  | { kind: "failed"; message: string };

function inTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

export async function revealFolder(path: string): Promise<RevealOutcome> {
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reveal_folder", { path });
      return { kind: "opened" };
    } catch (err) {
      // The folder was moved or deleted since the run, most likely. Said in the
      // words the Rust side used rather than a generic failure.
      return { kind: "failed", message: String((err as Error)?.message ?? err) };
    }
  }

  try {
    await navigator.clipboard.writeText(path);
    return { kind: "copied" };
  } catch {
    return { kind: "failed", message: strings.mission.workspaceNoClipboard };
  }
}
