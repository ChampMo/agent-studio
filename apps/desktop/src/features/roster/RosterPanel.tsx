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

function AgentCard({ agent, onEdit }: { agent: Agent; onEdit: () => void }) {
  const { duplicate, archive, restore, remove } = useAgentStore();
  // Two clicks to delete, and the second one says what it will do. There is no
  // undo behind it, unlike archiving.
  const [confirming, setConfirming] = useState(false);
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
        <Button variant="ghost" onClick={onEdit}>
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
        <Button variant="ghost" onClick={() => setConfirming((v) => !v)}>
          {strings.roster.delete}
        </Button>
      </div>

      {confirming ? (
        <div className="space-y-2 rounded-md border border-red-900/60 bg-red-950/30 p-3">
          {/* Says what actually happens, including the part people would not
              guess: finished missions keep their own copy of who ran them
              (§5.1), so the record survives. Team seats do not. */}
          <p className="text-xs text-red-300">{strings.roster.deleteWarning}</p>
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => remove(agent.id)}>
              {strings.roster.deleteConfirm}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {strings.teams.close}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RosterPanel() {
  const { agents, loading, error, showArchived } = useAgentStore();
  const { load, setShowArchived } = useAgentStore();
  const [creating, setCreating] = useState(false);
  // Editing is a page, not a panel inside a card: the card had no room for the
  // tools, the avatar or the backstory, so those could only ever be set once.
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const editing = agents.find((a) => a.id === editingId) ?? null;

  if (creating || editing) {
    return (
      <div className="h-full overflow-y-auto">
        <AgentCreator
          agent={editing ?? undefined}
          onDone={() => {
            setCreating(false);
            setEditingId(null);
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
            <AgentCard
              key={agent.id}
              agent={agent}
              onEdit={() => setEditingId(agent.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
