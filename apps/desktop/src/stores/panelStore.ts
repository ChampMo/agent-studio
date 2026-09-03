/**
 * What the right-hand panel is showing, and how wide it is (§18.2).
 *
 * A store rather than props because the two ends are far apart: the buttons
 * that switch it live in the mission header, inside `main`, and the panel is a
 * sibling of `main` in the shell. Threading state through `App` → `AppShell` →
 * `main` would make three components know about a choice that belongs to
 * neither of them.
 *
 * **Width is per mode, and that is the point.** The terminal wants room — 80
 * columns of monospace is about 580px, and below that every real command wraps
 * — while the run panel is a column of short rows that looks silly stretched.
 * One remembered width would be wrong for one of them every time you switched.
 *
 * Both are then draggable, and the drag is what is remembered. The defaults are
 * a starting point, not a policy.
 *
 * **There is deliberately no `widthOf` action.** The obvious shape — a resolver
 * on the store that reads `widths` and falls back to a default — is the trap
 * CLAUDE.md has now recorded three times: a zustand action's identity never
 * changes, so a component subscribing to it never re-renders when the data it
 * reads does. The drag recorded the new width and the panel stayed put.
 *
 * So the resolver is a plain function of state, and `usePanelWidth` subscribes
 * to the *number*. Selecting a primitive is the only shape here that cannot go
 * quietly stale.
 */
import { create } from "zustand";

export type PanelMode = "run" | "terminal";

/** Enough for 80 columns of the mono stack at 12px, plus padding. */
const DEFAULT_WIDTH: Record<PanelMode, number> = { run: 316, terminal: 560 };

export const MIN_WIDTH = 240;
export const MAX_WIDTH = 900;

const KEY = "agent-studio.panel-width";

function remembered(): Partial<Record<PanelMode, number>> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<PanelMode, number>>) : {};
  } catch {
    // Private browsing, or storage denied. A width that cannot be saved is not
    // a reason to fail.
    return {};
  }
}

function remember(widths: Partial<Record<PanelMode, number>>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths));
  } catch {
    /* nothing to do, and nothing worth telling the user */
  }
}

export interface PanelState {
  /** Null means closed — the work area gets the whole window. */
  mode: PanelMode | null;
  widths: Partial<Record<PanelMode, number>>;
  /** Open this panel, or close it if it is already the one showing. */
  toggle: (mode: PanelMode) => void;
  open: (mode: PanelMode) => void;
  close: () => void;
  setWidth: (mode: PanelMode, px: number) => void;
}

export const usePanelStore = create<PanelState>((set, get) => ({
  mode: "run",
  widths: remembered(),

  toggle: (mode) => set((s) => ({ mode: s.mode === mode ? null : mode })),
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),

  setWidth: (mode, px) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(px)));
    const widths = { ...get().widths, [mode]: clamped };
    set({ widths });
    remember(widths);
  },
}));

/** The width to draw a panel at: what was dragged, or the default for it. */
export function widthFor(
  widths: Partial<Record<PanelMode, number>>,
  mode: PanelMode,
): number {
  return widths[mode] ?? DEFAULT_WIDTH[mode];
}

/**
 * The current panel's width, or 0 when nothing is open. A number, so the store
 * can tell that it changed — and a plain function, so it can be tested without
 * rendering anything.
 */
export function selectPanelWidth(state: PanelState): number {
  return state.mode ? widthFor(state.widths, state.mode) : 0;
}

export function usePanelWidth(): number {
  return usePanelStore(selectPanelWidth);
}
