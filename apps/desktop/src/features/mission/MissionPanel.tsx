/**
 * The middle column, in its two states (PROJECT_BRIEF.md §7, §12 M4, §18.2).
 *
 * Before a run exists this is a setup form: name it, pick a team, pick the
 * folder they may touch. It creates nothing — a run with nothing said to it is
 * not a run — and hands over to `MissionView`, where the first message is what
 * actually starts the work.
 *
 * That split is the point. Setting a run up and deciding what to ask are two
 * different thoughts, and the old form made you have both at once, in one
 * textarea, before anything existed. Now the title names the thing you are
 * about to do and the conversation is where you do it.
 */
import { useEffect, useMemo, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { Select } from "../../components/ui/Select";
import { Checkbox } from "../../components/ui/Checkbox";
import { useMissionStore } from "../../stores/missionStore";
import { useTeamStore } from "../../stores/teamStore";
import { Field } from "../../components/ui/primitives";
import { MissionView } from "./MissionView";
import { WorkspacePicker } from "./WorkspacePicker";
import { TeamHistory } from "./TeamHistory";
import { useToolStore } from "../../stores/toolStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAgentStore } from "../../stores/agentStore";
import { api, type BudgetLimits } from "../../transport/rest";
import {
  BudgetOverrides,
  overridesToBody,
  type Overrides,
} from "../settings/BudgetOverrides";

export function MissionPanel() {
  const { teams, load: loadTeams } = useTeamStore();
  const missionId = useMissionStore((s) => s.missionId);
  const draft = useMissionStore((s) => s.draft);
  const beginDraft = useMissionStore((s) => s.beginDraft);
  const chosenWorkspace = useWorkspaceStore((s) => s.chosen);
  const agents = useAgentStore((s) => s.agents);
  const tools = useToolStore((s) => s.tools);
  const loadTools = useToolStore((s) => s.load);
  const loadAgents = useAgentStore((s) => s.load);

  const [teamId, setTeamId] = useState("");
  const [title, setTitle] = useState("");
  //: On by default. Seeing the plan first is the only point where stopping
  //: still saves the cost of the work, and a team that has just been pointed
  //: at a folder is exactly when that is worth a look. Turning it off is one
  //: click and it is remembered by nothing, so the choice is made per run.
  const [requireApproval, setRequireApproval] = useState(true);
  //: Only what this run wants to differ on. Blank inherits, field by field.
  const [budget, setBudget] = useState<Overrides>({});
  const [appBudget, setAppBudget] = useState<BudgetLimits | null>(null);

  useEffect(() => {
    void api
      .budget()
      .then((r) => setAppBudget(r.value))
      // Not guessed. A wrong inherited number in the placeholder would be
      // worse than an empty box.
      .catch(() => setAppBudget(null));
  }, []);

  useEffect(() => {
    void loadTeams();
    void loadTools();
    void loadAgents();
  }, [loadTeams, loadTools, loadAgents]);

  const runnable = teams.filter((t) => t.canRun && !t.archivedAt);
  const team = teams.find((t) => t.id === teamId) ?? runnable[0] ?? null;

  // Which of this team's tools cannot run without a folder. Asked of the
  // registry rather than hardcoded here: the backend owns that list, and the
  // launch gate refuses on the same answer (§16.2).
  const needsWorkspace = useMemo(() => {
    if (!team) return [];
    const wanted = new Set(
      team.members.flatMap((m) => agents.find((a) => a.id === m.agentId)?.tools ?? []),
    );
    return tools
      .filter((t) => t.requires.includes("workspace") && wanted.has(t.id))
      .map((t) => t.id);
  }, [team, agents, tools]);

  //: What a blank box is actually worth here: the app's numbers with the
  //: team's own on top, which is precedence resolved for display exactly the
  //: way `resolve_limits` resolves it for the run (§10, §2.1).
  const teamBudget = (team?.defaultBudget ?? {}) as Partial<
    Record<keyof BudgetLimits, number>
  >;
  const teamSetsSomething = Object.keys(teamBudget).length > 0;
  const inherited: BudgetLimits | null = appBudget
    ? { ...appBudget, ...teamBudget }
    : null;

  if (missionId || draft) return <MissionView />;

  const blocked = needsWorkspace.length > 0 && !chosenWorkspace;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <div className="space-y-1">
          {/* Sentence case. A heading in capitals is shouted, not structured. */}
          <h1 className="text-[17px] font-semibold text-text">
            {strings.mission.startTitle}
          </h1>
          <p className="text-sm text-muted">{strings.mission.startHint}</p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!team || !title.trim() || blocked) return;
            // Nothing is created here. The first message does that.
            beginDraft({
              title: title.trim(),
              teamId: team.id,
              workspaceRoot: chosenWorkspace?.path ?? null,
              requireApproval,
              budget: overridesToBody(budget),
            });
            setTitle("");
          }}
          className="surface space-y-4 p-4"
        >
          <Field label={strings.mission.titleLabel} hint={strings.mission.titleHint}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder={strings.mission.titlePlaceholder}
              className={cn(
                "w-full rounded-[9px] border border-line bg-solid px-3 py-2",
                "text-sm text-text placeholder:text-faint",
              )}
            />
          </Field>

          <Field label={strings.mission.teamLabel}>
            <Select
              value={team?.id ?? ""}
              onChange={setTeamId}
              placeholder={strings.mission.noRunnableTeam}
              options={runnable.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Field>

          {/* A file tool with no folder has no boundary at all (§16.2). */}
          <WorkspacePicker required={needsWorkspace.length > 0} />
          {blocked ? (
            <p className="text-xs text-wait">
              {strings.workspace.blocked} ({needsWorkspace.join(", ")})
            </p>
          ) : null}

          {/* On by default, and one click to turn off for this run. */}
          <Checkbox
            checked={requireApproval}
            onChange={setRequireApproval}
            label={strings.mission.approvalLabel}
            hint={strings.mission.approvalHint}
          />

          {/* Folded, like the team's. Most runs want the limits they inherit,
              and a launch form that opens with four number boxes suggests they
              are something you have to decide. */}
          <details>
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-text">
              {strings.budget.runTitle}
            </summary>
            <div className="pt-2">
              <BudgetOverrides
                values={budget}
                inherited={inherited}
                onChange={setBudget}
                inheritedFrom={
                  teamSetsSomething ? strings.budget.runFrom : strings.budget.teamFrom
                }
              />
              {/* The record, beside the field where the ceiling is typed. Not
                  a forecast: there is no honest way to estimate a run, and
                  more runs died of a budget set blind than of anything else
                  seen this week. */}
              <TeamHistory teamId={team?.id ?? null} />
            </div>
          </details>

          <button
            type="submit"
            disabled={!team || !title.trim() || blocked}
            className={cn(
              "min-h-[24px] rounded-[9px] bg-accent px-4 py-2.5 text-sm font-medium",
              "text-[#08222c] transition-[filter] hover:brightness-110 disabled:opacity-40",
            )}
          >
            {strings.mission.create}
          </button>
        </form>
      </div>
    </div>
  );
}
