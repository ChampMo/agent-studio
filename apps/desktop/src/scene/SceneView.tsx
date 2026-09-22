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
import { useThemeStore } from "../stores/themeStore";
import { strings } from "../lib/constants/strings.en";
import { deriveSceneState } from "./bindings/sceneState";
import { Scene } from "./engine/stage";
import { isSoundOn, justHappened, playChime, playTool, setSoundOn, shouldChime } from "./audio";
import { propFor } from "./entities/props";
import { shouldAnimate } from "./engine/activity";
import { cn } from "../lib/cn";
import { COMPACT_BELOW } from "../components/ui/splitter";
import { CompactRoster } from "./CompactRoster";
import { closeThisSceneWindow, popOutScene } from "../lib/popout";
import {
  AutoModeIcon,
  PopInIcon,
  PopOutIcon,
  RoomIcon,
  RosterIcon,
} from "../components/ui/icons";

/**
 * How the pane draws: by its height, or pinned to one drawing.
 *
 * A preference about this machine's screen rather than about the run, so it
 * lives in localStorage like the sound switch and the panel widths.
 */
export type SceneMode = "auto" | "room" | "roster";
const MODE_KEY = "agent-studio.scene-mode";
const NEXT_MODE: Record<SceneMode, SceneMode> = { auto: "room", room: "roster", roster: "auto" };
const MODE_TITLE: Record<SceneMode, () => string> = {
  auto: () => strings.scene.modeAuto,
  room: () => strings.scene.modeRoom,
  roster: () => strings.scene.modeRoster,
};
const MODE_ICON: Record<SceneMode, (props: { size?: number }) => JSX.Element> = {
  auto: AutoModeIcon,
  room: RoomIcon,
  roster: RosterIcon,
};
/** The three small buttons in the top-right corner share one look. */
const TOP_BUTTON =
  "absolute top-2 flex h-6 w-7 items-center justify-center rounded bg-solid text-[11px] text-muted hover:text-text";

function readMode(): SceneMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return raw === "room" || raw === "roster" ? raw : "auto";
  } catch {
    return "auto";
  }
}
function writeMode(mode: SceneMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembering it is not a reason to fail.
  }
}

export function SceneView({
  heightPx = Infinity,
  standalone = false,
}: {
  heightPx?: number;
  /** Already in a window of its own: no button to open another. */
  standalone?: boolean;
} = {}) {
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
    documentVisible:
      typeof document === "undefined" || document.visibilityState === "visible",
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
  // Too short to be a room. The pane changes what it draws rather than drawing
  // the same thing badly — see `CompactRoster`. Unless told otherwise: the
  // mode button pins either drawing, and is remembered per machine.
  const [mode, setMode] = useState<SceneMode>(readMode);
  const compact =
    mode === "roster" || (mode === "auto" && heightPx < COMPACT_BELOW);

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

  // The same gate for things thrown across the room: only throws this
  // render has not seen, and only ones that just happened.
  const thrownUpTo = useRef(0);
  useEffect(() => {
    const now = Date.now();
    for (const item of state.throws) {
      if (item.seq <= thrownUpTo.current) continue;
      thrownUpTo.current = item.seq;
      if (justHappened(item.ts, now, replaying)) scene.current?.throw_(item);
    }
  }, [state.throws, replaying]);

  // A tool going on a desk makes its noise — the phone rings, the toolbox
  // clinks. Read off the same `activeTool` the desk draws, so the sound and
  // the picture cannot disagree, and never while replaying: a finished run
  // read back is a record, and a record does not ring.
  const toolsBefore = useRef(new Map<string, string | null>());
  useEffect(() => {
    for (const actor of state.actors) {
      const before = toolsBefore.current.get(actor.agentId) ?? null;
      toolsBefore.current.set(actor.agentId, actor.activeTool);
      if (replaying || actor.activeTool === before) continue;
      const prop = propFor(actor.activeTool);
      if (prop) playTool(prop);
    }
  }, [state.actors, replaying]);

  // A different mission is a different log, and its sequence starts again.
  useEffect(() => {
    chimedUpTo.current = 0;
    thrownUpTo.current = 0;
    toolsBefore.current.clear();
  }, [missionId]);

  // What to draw as soon as there is something to draw it with. Mounting is
  // async, so the first state usually exists before the renderer does.
  const latest = useRef({ state, layoutId, heightPx });
  latest.current = { state, layoutId, heightPx };

  useEffect(() => {
    // Nothing is mounted in compact mode: a WebGL context and a ticker for a
    // canvas that is not on screen is exactly the work `shouldAnimate` was
    // written to avoid. Switching back rebuilds it, which is a drag of the
    // splitter apart and costs nothing anybody will notice.
    if (compact) return;
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
      instance.expose();
      instance.onCameraChange(() => setDriven(instance.cameraDriven));
      // Draw immediately rather than waiting for the next event. A mission that
      // is paused, finished or simply quiet produces none, and the room stayed
      // empty until something happened to change the state.
      instance.render(latest.current.state, latest.current.layoutId);
      instance.setAnimating(
        shouldAnimate({ heightPx: latest.current.heightPx, ...awake }),
      );
    });

    return () => {
      cancelled = true;
      scene.current = null;
      setDriven(false);
      instance.destroy();
    };
  }, [compact]);

  useEffect(() => {
    scene.current?.render(state, layoutId);
  }, [state, layoutId]);

  // The room's colours are read out of the stylesheet at draw time, so a theme
  // change is a different room — but only if something asks for a draw. On a
  // live run the next event does; on a finished one nothing ever would, and
  // the afternoon room sat under dusk furniture until some other change came
  // along. Same subscription `Portrait` keeps, for the same reason.
  const theme = useThemeStore((s) => s.choice);
  useEffect(() => {
    scene.current?.render(latest.current.state, latest.current.layoutId);
  }, [theme]);

  //: Whether the view is where a person put it rather than where the scene
  //: would put it. Mirrored into React so the button below can exist; the
  //: scene remains the one that knows.
  const [driven, setDriven] = useState(false);

  // A round ending is the natural place to hand the camera back: the run has
  // stopped, whatever was being inspected is finished, and the next round
  // frames itself. Anything shorter — every event, say — would be the view
  // being taken away mid-look, which is what `driven` exists to prevent.
  useEffect(() => {
    if (state.endReason !== null) scene.current?.recentre();
  }, [state.endReason]);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-room-sky"
      // Put in the DOM so the claim is checkable from outside rather than
      // taken on trust: "the ticker stops when nobody is looking" is a
      // performance promise, and a promise nobody can inspect is a hope.
      data-animating={String(animating)}
    >
      {compact ? (
        <CompactRoster state={state} />
      ) : (
        <div ref={host} className="h-full w-full" />
      )}
      {!missionId ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-xs text-faint">{strings.scene.empty}</p>
        </div>
      ) : null}

      {/* Only once the view is somebody's. A permanent "recentre" over a room
          that is already centred is a button that does nothing, most of the
          time, on a surface with very little room — and its appearing is also
          the only thing that tells you the automatic camera has stepped
          aside. */}
      {driven ? (
        <button
          type="button"
          onClick={() => scene.current?.recentre()}
          title={strings.scene.recentreHint}
          className={cn(
            "absolute bottom-2 left-1/2 -translate-x-1/2 rounded-card",
            "border border-line bg-solid px-2.5 py-1 text-[11px]",
            "text-muted hover:text-text",
          )}
        >
          {strings.scene.recentre}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          const next = NEXT_MODE[mode];
          setMode(next);
          writeMode(next);
        }}
        title={MODE_TITLE[mode]()}
        aria-label={MODE_TITLE[mode]()}
        className={TOP_BUTTON + " right-[4.5rem]"}
      >
        {MODE_ICON[mode]({ size: 14 })}
      </button>
      {standalone ? (
        <button
          type="button"
          onClick={() => void closeThisSceneWindow()}
          title={strings.scene.popIn}
          aria-label={strings.scene.popIn}
          className={TOP_BUTTON + " right-10"}
        >
          <PopInIcon size={14} />
        </button>
      ) : missionId ? (
        <button
          type="button"
          onClick={() => void popOutScene(missionId)}
          title={strings.scene.popOut}
          aria-label={strings.scene.popOut}
          className={TOP_BUTTON + " right-10"}
        >
          <PopOutIcon size={14} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          const next = !sound;
          setSoundOn(next);
          setSound(next);
          // The click is also the gesture the browser wants before it will let
          // an AudioContext start, so confirm the setting audibly.
          if (next) playChime("message");
        }}
        title={sound ? strings.scene.soundOn : strings.scene.soundOff}
        // An emoji is not an accessible name, and a tooltip is not one either.
        aria-label={sound ? strings.scene.soundOn : strings.scene.soundOff}
        aria-pressed={sound}
        className={TOP_BUTTON + " right-2"}
      >
        {sound ? "🔊" : "🔇"}
      </button>
      {/* No ending caption here.

          The same sentence was already in two places that own it better: the
          mission header, which says `Round finished: crashed` beside the run's
          own title, and the transcript, which marks the ending in its proper
          position on the log. A third copy floating over the room was the one
          with no context — and it is the copy that got the M10 bug, captioning
          a round that had ended hours earlier over a team three tasks into the
          next one.

          `state.endReason` is still derived and still used: it is what sits
          everyone down. What is gone is a second surface repeating it. */}
    </div>
  );
}
