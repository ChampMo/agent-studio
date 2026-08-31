/**
 * How the frontend learns the backend's port and this launch's session token.
 *
 * One code path for both modes (PROJECT_BRIEF.md §4.2): in development the Vite
 * plugin inlines the global from the handshake file scripts/dev.mjs wrote; in a
 * packaged build Tauri injects the identical global. Neither reads it from an
 * env var or a build-time constant — those outlive the launch they belong to.
 */

export interface Handshake {
  apiBase: string;
  wsBase: string;
  token: string;
}

declare global {
  interface Window {
    __AGENT_STUDIO__?: Handshake;
  }
}

/**
 * Null when the backend has not written its handshake yet — Vite can serve the
 * page before the backend finishes booting. The UI shows a waiting state rather
 * than throwing on load.
 */
export function getHandshake(): Handshake | null {
  const h = window.__AGENT_STUDIO__;
  if (!h || !h.token || !h.apiBase) return null;
  return h;
}

export class NotReadyError extends Error {
  constructor() {
    super("backend handshake is not available yet");
    this.name = "NotReadyError";
  }
}

export function requireHandshake(): Handshake {
  const h = getHandshake();
  if (!h) throw new NotReadyError();
  return h;
}
