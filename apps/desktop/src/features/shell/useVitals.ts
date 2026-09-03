/**
 * The run's figures, assembled once.
 *
 * Two places draw them now — the panel and the composer's meter — and the
 * inputs (which events, which budget, which round started when) have to be the
 * same in both or the two would quietly disagree about the same run. The
 * derivation itself is `deriveVitals`, which is pure and tested; this is only
 * about handing it the same arguments.
 */
import { useEffect, useMemo, useState } from "react";

import { useEventStore } from "../../stores/eventStore";
import { useMissionStore } from "../../stores/missionStore";
import { useEndReason } from "../../stores/runState";
import { deriveVitals, type Vitals } from "./vitals";

export function useVitals(): Vitals {
  const budget = useMissionStore((s) => s.budget);
  const startedAt = useMissionStore((s) => s.startedAt);
  const endedAt = useMissionStore((s) => s.endedAt);
  const missionId = useMissionStore((s) => s.missionId);
  const events = useEventStore((s) => s.events);
  const endReason = useEndReason();
  const running = missionId !== null && endReason === null;

  // The clock has to move on its own while a run is live: nothing else ticks,
  // so "time used" would otherwise freeze at whatever the last event's arrival
  // happened to make it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  return useMemo(
    () => deriveVitals({ events, budget, startedAt, endedAt, now }),
    [events, budget, startedAt, endedAt, now],
  );
}
