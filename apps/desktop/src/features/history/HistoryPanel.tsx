/**
 * Past missions, reopened (PROJECT_BRIEF.md §12 M6).
 *
 * Opening one replays it through the same decoder and the same store a live
 * mission uses, so the timeline and the scene show the run as it happened —
 * with the roster frozen at launch, not today's agents (§5.1, §2.1).
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useEventStore } from "../../stores/eventStore";
import { useHistoryStore } from "../../stores/historyStore";
import { useMissionStore } from "../../stores/missionStore";
import { Badge, Button } from "../../components/ui/primitives";
import { SceneView } from "../../scene/SceneView";
import { ArtifactViewer } from "../artifacts/ArtifactViewer";
import { WorkspaceBanner } from "../mission/WorkspacePicker";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatDateTime(date);
}

function tone(mission: { status: string; endReason: string | null }) {
  if (mission.status === "waiting") return "warn" as const;
  if (mission.endReason === "completed") return "good" as const;
  if (mission.endReason && mission.endReason !== "cancelled")
    return "bad" as const;
  return "neutral" as const;
}

export function HistoryPanel() {
  const { missions, loading, openId, error, load, openMission, remove } =
    useHistoryStore();
  // Which run is asking to be confirmed. One at a time, and the confirmation
  // says what goes with it — there is no undo and no second copy.
  const [confirming, setConfirming] = useState<string | null>(null);
  const replaying = useEventStore((s) => s.replaying);
  const roster = useMissionStore((s) => s.roster);
  const goal = useMissionStore((s) => s.goal);
  const workspaceRoot = useMissionStore((s) => s.workspaceRoot);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          {strings.history.title}
        </h2>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? strings.history.loading : strings.history.refresh}
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {error ? <p className="text-xs text-stop">{error}</p> : null}

        {missions.length === 0 && !loading ? (
          <p className="text-xs text-faint">{strings.history.empty}</p>
        ) : null}

        <div className="space-y-1">
          {missions.map((mission) => (
            <div key={mission.id} className="space-y-1">
              <div
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-xs",
                  openId === mission.id
                    ? "border-accent bg-accent/10"
                    : "border-line bg-solid hover:bg-solid",
                )}
              >
                <button
                  type="button"
                  onClick={() => void openMission(mission.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-text">
                      {mission.goal || strings.history.noGoal}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {when(mission.startedAt)} · {mission.memberCount}{" "}
                      {strings.history.members}
                    </span>
                  </span>
                  {/* `running` is this process's answer, not the row's: a mission
                  left `running` by a launch that is gone is history. */}
                  {mission.running ? (
                    <Badge tone="good">{strings.history.live}</Badge>
                  ) : null}
                  <Badge tone={tone(mission)}>
                    {mission.status === "ended"
                      ? (mission.endReason ?? "ended")
                      : mission.status}
                  </Badge>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setConfirming((id) =>
                      id === mission.id ? null : mission.id,
                    )
                  }
                  className="shrink-0 rounded px-2 py-1 text-[11px] text-faint hover:bg-solid-2 hover:text-stop"
                >
                  {strings.history.delete}
                </button>
              </div>

              {confirming === mission.id ? (
                <div className="space-y-2 rounded-md border border-stop/40 bg-stop/10 p-3">
                  <p className="text-xs text-stop">
                    {mission.running
                      ? strings.history.deleteRunning
                      : strings.history.deleteWarning}
                  </p>
                  {!mission.running ? (
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        onClick={async () => {
                          await remove(mission.id);
                          setConfirming(null);
                        }}
                      >
                        {strings.history.deleteConfirm}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setConfirming(null)}
                      >
                        {strings.artifacts.close}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {openId && replaying ? (
          <div className="space-y-3 border-t border-line pt-3">
            <p className="text-xs text-muted">
              {strings.history.replaying}
              {goal ? ` — ${goal}` : ""}
            </p>

            {/* Where that run was working. A replay that cannot say is a replay
                that leaves out the thing files were written into (§16.2). */}
            <WorkspaceBanner path={workspaceRoot} />

            {/* The same scene component, fed by the same store. Nothing here
                knows whether the events arrived over a socket or off disk. */}
            <div className="h-64 overflow-hidden rounded-lg border border-line">
              <SceneView />
            </div>

            <div className="flex flex-wrap gap-2">
              {roster.map((member) => (
                <div
                  key={member.agent_id}
                  className="rounded-md border border-line bg-solid px-3 py-1.5 text-[11px] text-muted"
                >
                  <span className="text-text">
                    {member.role_in_team === "leader" ? "★ " : ""}
                    {member.name}
                  </span>
                  {member.model ? ` · ${member.model}` : ""}
                </div>
              ))}
            </div>

            <ArtifactViewer />
          </div>
        ) : null}
      </div>
    </div>
  );
}
