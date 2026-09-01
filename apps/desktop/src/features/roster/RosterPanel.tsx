/**
 * The roster, as character cards (PROJECT_BRIEF.md §12 M2).
 *
 * The game feel lives in the presentation — portrait, dark card, traits — and
 * never in invented numbers (§1.1). Every figure here is a fact about the
 * agent: the model it runs on, the tools it carries, how many missions it has
 * actually finished. No level, no exp, no progress bar.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { useAgentStore } from "../../stores/agentStore";
import { Badge, Button } from "../../components/ui/primitives";
import type { Agent } from "../../transport/rest";
import { AgentCreator } from "../agent-creator/AgentCreator";
import { ToolPicker } from "../agent-creator/ToolPicker";
import type { Autonomy } from "../../transport/rest";

function AgentCard({ agent }: { agent: Agent }) {
  const { duplicate, archive, restore, update } = useAgentStore();
  const [editing, setEditing] = useState(false);
  const [tools, setTools] = useState<string[]>(agent.tools ?? []);
  const [autonomy, setAutonomy] = useState<Autonomy>(agent.autonomy ?? "ask_dangerous");
  const [prompt, setPrompt] = useState(agent.systemPrompt);
  const archived = agent.archivedAt !== null;

  return (
    <div
      className={`space-y-3 rounded-lg border p-4 ${
        archived
          ? "border-slate-800 bg-slate-900/20 opacity-60"
          : "border-slate-700 bg-slate-900/50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-100">{agent.name}</div>
          <div className="truncate text-xs text-slate-400">{agent.title}</div>
        </div>
        {archived ? (
          <Badge tone="warn">{strings.roster.archived}</Badge>
        ) : null}
      </div>

      {/* Facts only: what it runs on, and what it has actually done (§1.1). */}
      <div className="flex justify-between text-[11px] text-slate-500">
        <span>
          {agent.totalMissions} {strings.roster.missions}
        </span>
        <span className="font-mono">{agent.model ?? "—"}</span>
      </div>

      <p className="line-clamp-3 text-xs text-slate-400">{agent.role}</p>

      <div className="flex flex-wrap gap-1">
        {agent.personalityTraits.slice(0, 4).map((trait) => (
          <Badge key={trait}>{trait}</Badge>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 border-t border-slate-800 pt-2">
        <Button variant="ghost" onClick={() => setEditing((v) => !v)}>
          {strings.roster.edit}
        </Button>
        {/* The sanctioned way to freeze a configuration: teams reference agents
            live and there is no versioning (§5). */}
        <Button variant="ghost" onClick={() => duplicate(agent.id)}>
          {strings.roster.duplicate}
        </Button>
        {archived ? (
          <Button variant="ghost" onClick={() => restore(agent.id)}>
            {strings.roster.restore}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => archive(agent.id)}>
            {strings.roster.archive}
          </Button>
        )}
      </div>

      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await update(agent.id, {
              system_prompt: prompt,
              tools,
              autonomy,
            });
            setEditing(false);
          }}
          className="space-y-3"
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
          />
          {/* Editable after creation, because what an agent is allowed to do is
              the kind of decision people revisit — and because an agent made
              before M8 carries no tools at all. */}
          <ToolPicker
            value={tools}
            autonomy={autonomy}
            onChange={setTools}
            onAutonomyChange={setAutonomy}
          />
          <Button type="submit">{strings.roster.saveEdit}</Button>
        </form>
      ) : null}
    </div>
  );
}

export function RosterPanel() {
  const { agents, loading, error, showArchived } = useAgentStore();
  const { load, setShowArchived } = useAgentStore();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  if (creating) {
    return (
      <div className="h-full overflow-y-auto">
        <AgentCreator
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {strings.roster.title}
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {strings.roster.showArchived}
          </label>
          <Button onClick={() => setCreating(true)}>{strings.roster.create}</Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error ? (
          <p className="rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}

        {!loading && agents.length === 0 ? (
          <p className="text-sm text-slate-500">{strings.roster.empty}</p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      </div>
    </div>
  );
}
