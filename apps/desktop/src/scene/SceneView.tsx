/**
 * The scene, wired to the same event store the timeline reads (§2.1).
 *
 * This component owns no state of its own. It derives a `SceneState` from the
 * events and the mission's frozen roster, and hands it to the renderer. If the
 * scene ever shows something the timeline does not, one of them is lying — and
 * with a single derivation from a single store, neither can.
 */
import { useEffect, useMemo, useRef } from "react";

import { useEventStore } from "../stores/eventStore";
import { useMissionStore } from "../stores/missionStore";
import { useTeamStore } from "../stores/teamStore";
import { strings } from "../lib/constants/strings.en";
import { deriveSceneState } from "./bindings/sceneState";
import { Scene } from "./engine/stage";

export function SceneView() {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);

  const events = useEventStore((s) => s.events);
  const roster = useMissionStore((s) => s.roster);
  const missionId = useMissionStore((s) => s.missionId);
  const teams = useTeamStore((s) => s.teams);
  const layouts = useTeamStore((s) => s.layouts);

  const layoutId = useMemo(() => {
    const team = teams.find((t) => t.members.length === roster.length);
    return team?.sceneLayoutId ?? null;
  }, [teams, roster.length]);

  const seats = useMemo(
    () => layouts.find((l) => l.id === layoutId)?.seats ?? roster.length,
    [layouts, layoutId, roster.length],
  );

  const state = useMemo(
    () => deriveSceneState({ roster, events, seats }),
    [roster, events, seats],
  );

  useEffect(() => {
    let cancelled = false;
    const instance = new Scene();
    const element = host.current;
    if (!element) return;

    void instance.mount(element).then(() => {
      if (cancelled) {
        instance.destroy();
        return;
      }
      scene.current = instance;
    });

    return () => {
      cancelled = true;
      scene.current = null;
      instance.destroy();
    };
  }, []);

  useEffect(() => {
    scene.current?.render(state, layoutId);
  }, [state, layoutId]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0b1120]">
      <div ref={host} className="h-full w-full" />
      {!missionId ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-xs text-slate-600">{strings.scene.empty}</p>
        </div>
      ) : null}
      {state.endReason ? (
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2">
          <span className="rounded bg-slate-900/80 px-2 py-1 text-[11px] text-slate-400">
            {strings.scene.ended(state.endReason)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
