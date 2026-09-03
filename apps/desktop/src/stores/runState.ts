/**
 * Is the run on screen still going?
 *
 * There are two answers to that and they come from different places, which is
 * how the header ended up saying **Working** over a mission that had stopped
 * twenty minutes earlier.
 *
 * `missionStore.endReason` is the mission *row*, read once over REST when the
 * run is opened or launched. At launch it is null, and nothing ever updates it
 * — so a run that ends while you are watching leaves the row's answer frozen at
 * "still going", with a live Stop button and a composer that refuses to type.
 *
 * `eventStore.endReason` is the *log*: set by `mission.ended` as it arrives, and
 * equally by the replay, because a replay pushes the same events through the
 * same ingest (§2.1). That makes it right in both directions, and it is the
 * source §1 wants — the log is what actually happened.
 *
 * The row is still the fallback, for the one case the log cannot cover: a
 * mission whose process died is closed as `crashed` by `reap_orphans()` at
 * startup, and a dead process publishes nothing. Without the fallback those
 * would read as running for ever, which is the same lie from the other side.
 */
import { useEventStore } from "./eventStore";
import { useMissionStore } from "./missionStore";

/** Why this run stopped, or null while it is still going. */
export function useEndReason(): string | null {
  const fromLog = useEventStore((s) => s.endReason);
  const fromRow = useMissionStore((s) => s.endReason);
  return fromLog ?? fromRow;
}

/** Whether a run exists and has not stopped. */
export function useIsRunning(): boolean {
  const missionId = useMissionStore((s) => s.missionId);
  return missionId !== null && useEndReason() === null;
}

/**
 * Which ceiling stopped the round, when one did.
 *
 * Same two sources and the same precedence as `useEndReason`: the log first,
 * the row as the fallback for a mission reaped as `crashed` at startup, where
 * a dead process published no ending of its own.
 */
export function useEndLimit(): string | null {
  const fromLog = useEventStore((s) => s.endLimit);
  const fromRow = useMissionStore((s) => s.endLimit);
  return fromLog ?? fromRow;
}
