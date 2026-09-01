/**
 * The scene, wired to the same event store the timeline reads (§2.1).
 *
 * This component owns no state of its own. It derives a `SceneState` from the
 * events and the mission's frozen roster, and hands it to the renderer. If the
 * scene ever shows something the timeline does not, one of them is lying — and
 * with a single derivation from a single store, neither can.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useEventStore } from "../stores/eventStore";
import { useMissionStore } from "../stores/missionStore";
import { useTeamStore } from "../stores/teamStore";
import { strings } from "../lib/constants/strings.en";
import { deriveSceneState } from "./bindings/sceneState";
import { Scene } from "./engine/stage";
import { isSoundOn, playChime, setSoundOn, shouldChime } from "./audio";
import { shouldAnimate } from "./engine/activity";

export function SceneView({ heightPx = Infinity }: { heightPx?: number } = {}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);

  const events = useEventStore((s) => s.events);
  const streaming = useEventStore((s) => s.streaming);
  const replaying = useEventStore((s) => s.replaying);
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
    () => deriveSceneState({ roster, events, seats, streaming }),
    [roster, events, seats, streaming],
  );

  const [sound, setSound] = useState(isSoundOn);
  // Focus and visibility, watched rather than polled. The scene is mounted all
  // the time now (§17.1), so "nobody is looking" is a state it has to know.
  const [awake, setAwake] = useState(() => ({
    windowFocused: typeof document === "undefined" || document.hasFocus(),
    documentVisible: typeof document === "undefined" || document.visibilityState === "visible",
  }));

  useEffect(() => {
    const update = () =>
      setAwake({
        windowFocused: document.hasFocus(),
        documentVisible: document.visibilityState === "visible",
      });
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // Not a CSS `display: none`: that stops the painting and leaves the loop
  // running. The ticker itself is stopped (§12 M9 criterion 2).
  const animating = shouldAnimate({ heightPx, ...awake });
  useEffect(() => {
    scene.current?.setAnimating(animating);
  }, [animating]);
  const chimedUpTo = useRef(0);

  // Only events this render has not already sounded, and only ones that just
  // happened: a reconnect replays the log from seq 0, and History replays whole
  // finished missions (see `shouldChime`).
  useEffect(() => {
    const now = Date.now();
    for (const { event } of events) {
      if (event.seq <= chimedUpTo.current) continue;
      chimedUpTo.current = event.seq;
      const kind = shouldChime(event, now, replaying);
      if (kind) playChime(kind);
    }
  }, [events, replaying]);

  // A different mission is a different log, and its sequence starts again.
  useEffect(() => {
    chimedUpTo.current = 0;
  }, [missionId]);

  // What to draw as soon as there is something to draw it with. Mounting is
  // async, so the first state usually exists before the renderer does.
  const latest = useRef({ state, layoutId, heightPx });
  latest.current = { state, layoutId, heightPx };

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
      // Draw immediately rather than waiting for the next event. A mission that
      // is paused, finished or simply quiet produces none, and the room stayed
      // empty until something happened to change the state.
      instance.render(latest.current.state, latest.current.layoutId);
      instance.setAnimating(shouldAnimate({ heightPx: latest.current.heightPx, ...awake }));
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
    <div
      className="relative h-full w-full overflow-hidden bg-[#0b1120]"
      // Put in the DOM so the claim is checkable from outside rather than
      // taken on trust: "the ticker stops when nobody is looking" is a
      // performance promise, and a promise nobody can inspect is a hope.
      data-animating={String(animating)}
    >
      <div ref={host} className="h-full w-full" />
      {!missionId ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-xs text-slate-600">{strings.scene.empty}</p>
        </div>
      ) : null}
      <button
        onClick={() => {
          const next = !sound;
          setSoundOn(next);
          setSound(next);
          // The click is also the gesture the browser wants before it will let
          // an AudioContext start, so confirm the setting audibly.
          if (next) playChime("message");
        }}
        title={sound ? strings.scene.soundOn : strings.scene.soundOff}
        className="absolute right-2 top-2 rounded bg-slate-900/70 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
      >
        {sound ? "🔊" : "🔇"}
      </button>
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
