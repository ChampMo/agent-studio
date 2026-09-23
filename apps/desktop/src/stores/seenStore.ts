/**
 * Which finished runs you have already looked at.
 *
 * The list used to print a state on every row — *Finished*, *Out of budget*,
 * *Stopped badly* — seventeen times down the side of a window whose middle
 * column says the same thing about the run you actually have open. The word is
 * true and, repeated, it answers a question nobody asked.
 *
 * What a list of past runs is for is the one thing it could not say: **which
 * of these finished while I was looking at something else.** So the state comes
 * off the row and a dot goes on, and the dot means exactly one thing.
 *
 * Kept in `localStorage`, not on the log. Whether *you* have read something is
 * not a fact about the run — it is not part of the record, it does not belong
 * in an append-only table, and it is per-person and per-machine (§9.3). A
 * browser that cannot store it simply shows every ended run as unread, which
 * is the safe direction: the failure is a dot too many, never a run you were
 * never told about.
 *
 * Keyed on `endedAt`, not on the id. A mission can be continued, so a run you
 * read yesterday that ended again this morning is unread again — which is the
 * point of the mark, and what a bare "seen this id" would get wrong.
 */
import { create } from "zustand";

const KEY = "agent-studio.seen.v1";
/** Enough for a long history; the oldest are dropped first, and an old run
 *  losing its mark shows a dot on something already finished — harmless. */
const MAX = 500;

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, string>;
  } catch {
    // A private window, cleared site data, or a browser refusing storage.
    return {};
  }
}

function save(seen: Record<string, string>): void {
  try {
    const keys = Object.keys(seen);
    const trimmed =
      keys.length <= MAX
        ? seen
        : Object.fromEntries(keys.slice(keys.length - MAX).map((k) => [k, seen[k]!]));
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Nothing to do about it, and nothing that should break because of it.
  }
}

interface SeenState {
  seen: Record<string, string>;
  /** Records that this run, as it stands now, has been read. */
  markSeen: (missionId: string, endedAt: string | null) => void;
}

export const useSeenStore = create<SeenState>((set, get) => ({
  seen: load(),

  markSeen: (missionId, endedAt) => {
    // A run that has not ended cannot be "read": it is still happening, and
    // marking it now would hide the ending when it arrives.
    if (!endedAt) return;
    if (get().seen[missionId] === endedAt) return;
    const next = { ...get().seen, [missionId]: endedAt };
    save(next);
    set({ seen: next });
  },
}));

/**
 * The endings nobody needs to be told about, because they *are* the telling.
 *
 * `cancelled` is written in exactly two places and both of them are the person
 * acting: the Stop button, and rejecting a plan at the gate. Marking such a run
 * unread says *this finished while you were looking at something else* to
 * somebody who was looking straight at it and is the reason it finished.
 *
 * Everything else stays. `crashed` especially: a run the backend closed because
 * its process died is exactly what a person needs a dot for, and it is the one
 * ending nobody chose.
 */
const ENDED_BY_YOU = new Set(["cancelled"]);

/** True when a run has finished and this browser has not opened it since. */
export function isUnread(
  seen: Record<string, string>,
  mission: { id: string; endedAt: string | null; endReason: string | null },
): boolean {
  if (!mission.endReason || !mission.endedAt) return false;
  if (ENDED_BY_YOU.has(mission.endReason)) return false;
  return seen[mission.id] !== mission.endedAt;
}
