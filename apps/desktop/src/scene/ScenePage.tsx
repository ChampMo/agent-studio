/**
 * A window that is only the room (`lib/popout.ts`).
 *
 * The same stores, the same `openMission`, the same `SceneView` — this is not
 * a second renderer, it is the ordinary one with nothing beside it (§2.1).
 * The window's own height is the pane's height, so the room never falls into
 * the compact roster here unless the window really is that short.
 */
import { useEffect, useState } from "react";

import { strings } from "../lib/constants/strings.en";
import { useHistoryStore } from "../stores/historyStore";
import { useMissionStore } from "../stores/missionStore";
import { useTeamStore } from "../stores/teamStore";
import { SceneView } from "./SceneView";

export function ScenePage({ missionId }: { missionId: string }) {
  const openMission = useHistoryStore((s) => s.openMission);
  const loadTeams = useTeamStore((s) => s.load);
  const title = useMissionStore((s) => s.title);
  const error = useHistoryStore((s) => s.error);

  useEffect(() => {
    // Teams first: the layout — which desks, how many — is read off the team
    // whose size matches the roster, and without the list the room would be
    // drawn on the fallback grid and then redrawn.
    void loadTeams().then(() => openMission(missionId));
  }, [loadTeams, openMission, missionId]);

  useEffect(() => {
    if (title) document.title = `${title} — ${strings.scene.popOutTitle}`;
  }, [title]);

  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const measure = () => setHeight(window.innerHeight);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div className="h-full w-full">
      {error ? (
        <p className="p-4 text-sm text-stop">{error}</p>
      ) : (
        <SceneView heightPx={height} standalone />
      )}
    </div>
  );
}
