/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than two, and the third is the default. "Follow the
 * system" is a different thing from "dark": someone whose laptop switches at
 * sunset has said something, and a build that quietly pinned dark on first run
 * would be overriding it — the same distinction `ProbeResult.conclusive` draws
 * between a fact and the absence of one.
 *
 * Applied by stamping `data-theme` on `<html>`, which the stylesheet reads.
 * Nothing else in the app knows about themes: every colour goes through a
 * token, so the toggle is one attribute and the scene reads the same variables
 * the DOM does.
 *
 * Kept in `localStorage`, not on the backend. Which theme this person likes on
 * this machine is not part of any run's record (§9.3), and a browser that
 * refuses storage simply follows the system every time — the safe direction.
 */
import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "agent-studio.theme.v1";

function load(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "light" || raw === "dark" || raw === "system"
      ? raw
      : "system";
  } catch {
    return "system";
  }
}

/** Stamp it, or clear it so the media query decides. */
export function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

interface ThemeState {
  choice: ThemeChoice;
  set: (choice: ThemeChoice) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  choice: load(),
  set: (choice) => {
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // Nothing to do about it, and nothing that should break because of it.
    }
    apply(choice);
    set({ choice });
  },
}));

/** Which one is actually in force — for the scene, which needs a real answer
 *  rather than "system". */
export function resolved(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
