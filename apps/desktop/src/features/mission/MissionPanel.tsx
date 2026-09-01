/**
 * Launch a team and watch it work (PROJECT_BRIEF.md §7, §12 M4).
 *
 * The roster shown while a mission runs comes from the mission's frozen
 * snapshot, not the agents table — the same source the timeline names agents
 * from. Rename an agent mid-flight and this panel keeps showing who is actually
 * doing the work (§5.1).
 */
import { useEffect, useMemo, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { api } from "../../transport/rest";
import { useEventStore } from "../../stores/eventStore";
import { useMissionStore } from "../../stores/missionStore";
import { useTeamStore } from "../../stores/teamStore";
import { Badge, Button, Field, Input } from "../../components/ui/primitives";
import { SceneView } from "../../scene/SceneView";
import { WorkspaceBanner, WorkspacePicker } from "./WorkspacePicker";
import { useToolStore } from "../../stores/toolStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAgentStore } from "../../stores/agentStore";

interface TaskRow {
  taskId: string;
  label: string;
  state: string;
  done: number;
  total: number;
}

export function MissionPanel() {
  const { teams, load: loadTeams } = useTeamStore();
  const { missionId, roster, endReason, launching, rejected, workspaceRoot } =
    useMissionStore();
  const chosenWorkspace = useWorkspaceStore((s) => s.chosen);
  const agents = useAgentStore((s) => s.agents);
  const tools = useToolStore((s) => s.tools);
  const loadTools = useToolStore((s) => s.load);
  const loadAgents = useAgentStore((s) => s.load);
  const { launch, clear } = useMissionStore();
  const events = useEventStore((s) => s.events);
  const connection = useEventStore((s) => s.connection);

  const [teamId, setTeamId] = useState("");
  const [goal, setGoal] = useState("");
  const [requireApproval, setRequireApproval] = useState(false);

  useEffect(() => {
    void loadTeams();
    void loadTools();
    void loadAgents();
  }, [loadTeams, loadTools, loadAgents]);

  const runnable = teams.filter((t) => t.canRun && !t.archivedAt);
  const team = teams.find((t) => t.id === teamId) ?? runnable[0] ?? null;
  const running = missionId !== null && endReason === null;

  // Which of this team's tools cannot run without a folder. Asked of the
  // registry rather than hardcoded here: the backend owns that list, and the
  // launch gate refuses on the same answer (§16.2).
  const needsWorkspace = useMemo(() => {
    if (!team) return [];
    const wanted = new Set(
      team.members.flatMap(
        (m) => agents.find((a) => a.id === m.agentId)?.tools ?? [],
      ),
    );
    return tools
      .filter((t) => t.requires.includes("workspace") && wanted.has(t.id))
      .map((t) => t.id);
  }, [team, agents, tools]);

  // One row per task, latest state wins. Counted, never a percentage: no
  // honest percentage exists for agent work (§15 row 7).
  const tasks = useMemo(() => {
    const byId = new Map<string, TaskRow>();
    for (const { event } of events) {
      if (event.draft.type !== "mission.progress") continue;
      const p = event.draft.payload as unknown as TaskRow;
      byId.set(p.taskId, p);
    }
    return [...byId.values()];
  }, [events]);

  const statuses = useMemo(() => {
    const byAgent = new Map<string, string>();
    for (const { event } of events) {
      if (event.draft.type !== "agent.status") continue;
      const p = event.draft.payload as { agentId: string; status: string };
      byAgent.set(p.agentId, p.status);
    }
    // A mission that has ended leaves nobody working, whatever the last status
    // said — a cancelled run never gets to report `idle` (see CLAUDE.md).
    if (endReason !== null) for (const k of byAgent.keys()) byAgent.set(k, "idle");
    return byAgent;
  }, [events, endReason]);

  const spend = useMemo(() => {
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const { event } of events) {
      const usage = (event.draft.payload as { usage?: Record<string, number> })?.usage;
      if (!usage) continue;
      input += usage.inputTokens ?? 0;
      output += usage.outputTokens ?? 0;
      cost += usage.costUsd ?? 0;
    }
    return { input, output, cost };
  }, [events]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {strings.mission.title}
        </h2>
        <Badge tone={connection === "open" ? "good" : "neutral"}>
          {strings.connection[connection] ?? connection}
        </Badge>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {!running ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (team && goal.trim())
                void launch(team, goal.trim(), {
                  requireApproval,
                  workspaceRoot: chosenWorkspace?.path ?? null,
                });
            }}
            className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
          >
            <Field label={strings.mission.teamLabel}>
              <select
                value={team?.id ?? ""}
                onChange={(e) => setTeamId(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                {runnable.length === 0 ? (
                  <option value="">{strings.mission.noRunnableTeam}</option>
                ) : null}
                {runnable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.members.length} members
                  </option>
                ))}
              </select>
            </Field>

            {/* Before the goal, because it is the thing that has to be
                decided first: a file tool with no folder has no boundary. */}
            <WorkspacePicker required={needsWorkspace.length > 0} />
            {needsWorkspace.length > 0 && !chosenWorkspace ? (
              <p className="text-xs text-amber-400">
                {strings.workspace.blocked} ({needsWorkspace.join(", ")})
              </p>
            ) : null}

            <Field label={strings.mission.goalLabel} hint={strings.mission.goalHint}>
              <Input
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={strings.mission.goalPlaceholder}
              />
            </Field>

            {/* Opt-in. A gate on every run is a gate users switch off rather
                than one they read (§12 M6). */}
            <label className="flex items-start gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(e) => setRequireApproval(e.target.checked)}
                className="mt-0.5 accent-sky-500"
              />
              <span>
                {strings.mission.approvalLabel}
                <span className="block text-[11px] text-slate-500">
                  {strings.mission.approvalHint}
                </span>
              </span>
            </label>

            <Button
              type="submit"
              disabled={
                launching ||
                !team ||
                !goal.trim() ||
                (needsWorkspace.length > 0 && !chosenWorkspace)
              }
            >
              {launching ? strings.mission.launching : strings.mission.launch}
            </Button>

            {rejected ? (
              // Every blocking finding, because fixing a team one rejection at
              // a time is a guessing game (§5.2).
              <div className="rounded-md bg-red-950/50 p-3 text-xs text-red-300">
                <div className="font-medium">{strings.mission.rejected}</div>
                <ul className="mt-1 list-inside list-disc">
                  {rejected.map((problem, i) => (
                    <li key={i}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </form>
        ) : null}

        {missionId ? (
          <>
            {/* Visible for as long as the mission runs, not only when it was
                chosen: the user has to be able to see where files are going. */}
            <WorkspaceBanner path={workspaceRoot} />
            {/* The scene and the list below read the same events (§2.1). If
                they ever disagree, one of them is lying — and they cannot,
                because both come from one derivation. */}
            <div className="h-72 overflow-hidden rounded-lg border border-slate-800">
              <SceneView />
            </div>

            <div className="flex flex-wrap gap-2">
              {roster.map((member) => {
                const status = statuses.get(member.agent_id) ?? "idle";
                return (
                  <div
                    key={member.agent_id}
                    className={cn(
                      "rounded-md border px-3 py-2 text-xs",
                      status === "idle"
                        ? "border-slate-800 bg-slate-900/40 text-slate-400"
                        : "border-sky-800 bg-sky-950/40 text-sky-200",
                    )}
                  >
                    <div className="font-medium">
                      {member.role_in_team === "leader" ? "★ " : ""}
                      {member.name}
                    </div>
                    <div className="text-[11px] opacity-70">
                      seat {member.seat_index} · {status}
                    </div>
                  </div>
                );
              })}
            </div>

            {tasks.length > 0 ? (
              <div className="space-y-1">
                {tasks.map((task) => (
                  <div
                    key={task.taskId}
                    className="flex items-center gap-2 rounded-md border border-slate-800 px-3 py-1.5 text-xs"
                  >
                    <span
                      className={cn(
                        "w-14 shrink-0 uppercase",
                        task.state === "done" && "text-emerald-400",
                        task.state === "running" && "text-sky-400",
                        task.state === "failed" && "text-red-400",
                        task.state === "pending" && "text-slate-500",
                      )}
                    >
                      {task.state}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-slate-200">
                      {task.label}
                    </span>
                    <span className="shrink-0 text-slate-500">
                      {task.done}/{task.total}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Real money, as numbers. Not a power bar (§1.1). */}
            <div className="flex gap-4 text-[11px] text-slate-500">
              <span>
                {spend.input.toLocaleString()} in · {spend.output.toLocaleString()} out
              </span>
              {spend.cost > 0 ? <span>${spend.cost.toFixed(6)}</span> : null}
            </div>

            <div className="flex gap-2">
              {running ? (
                <Button
                  variant="danger"
                  onClick={() => api.cancelMission(missionId)}
                >
                  {strings.mission.stop}
                </Button>
              ) : (
                <Button variant="secondary" onClick={clear}>
                  {strings.mission.newRun}
                </Button>
              )}
            </div>

            {endReason && endReason !== "completed" ? (
              <p className="text-xs text-amber-400">
                {strings.mission.endedPrefix}: {endReason}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
