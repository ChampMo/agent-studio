/**
 * Settings that belong to the app rather than to any one agent (§16.4).
 *
 * `autonomy` — when a tool call stops to ask permission — used to be a field on
 * every agent, set in the agent editor under the tool list. Wrong twice over:
 * it asked a security question once per agent when the person means it once,
 * and it lived on a page nobody has open while a run is going, which is exactly
 * when you want to decide it.
 *
 * One value, next to the composer. Frozen into each mission's snapshot at
 * launch, so moving the switch mid-run cannot change what that run is allowed
 * to do (§5.1).
 */
import { create } from "zustand";
import { api } from "../transport/rest";

export type Autonomy = "ask_always" | "ask_dangerous" | "trusted";

interface PrefsState {
  autonomy: Autonomy;
  loaded: boolean;
  load: () => Promise<void>;
  setAutonomy: (value: Autonomy) => Promise<void>;
}

export const usePrefsStore = create<PrefsState>((set) => ({
  // The cautious one until the backend says otherwise. A default that asks
  // less than the stored setting would be the wrong direction to be wrong in.
  autonomy: "ask_dangerous",
  loaded: false,

  load: async () => {
    try {
      const { value } = await api.getAutonomy();
      set({ autonomy: value as Autonomy, loaded: true });
    } catch {
      // The backend not answering is not a reason to claim a permission level.
      set({ loaded: false });
    }
  },

  setAutonomy: async (value) => {
    // Optimistic, then confirmed: this control is beside a running mission and
    // a select that lags a round trip feels broken.
    set({ autonomy: value });
    try {
      const saved = await api.setAutonomy(value);
      set({ autonomy: saved.value as Autonomy });
    } catch {
      // Put it back rather than leave the UI showing a setting that was not
      // stored — this one decides whether `bash` asks first.
      const { value: actual } = await api.getAutonomy().catch(() => ({
        value: "ask_dangerous",
      }));
      set({ autonomy: actual as Autonomy });
    }
  },
}));
