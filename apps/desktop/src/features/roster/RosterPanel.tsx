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
import { Menu } from "../../components/ui/Menu";
import { MoreIcon } from "../../components/ui/icons";
import { cn } from "../../lib/cn";
import { Checkbox } from "../../components/ui/Checkbox";
import { Portrait } from "../../components/ui/Portrait";
import type { Agent } from "../../transport/rest";
import { AgentCreator } from "../agent-creator/AgentCreator";

/**
 * One agent, as a card (§12 M2, §18.3).
 *
 * Three fixed rows — head, body, facts — so every card in a row lines up. The
 * body takes `1fr`, which is what pushes the facts line to the bottom whatever
 * length the description happens to be. Grid already stretches cards to the
 * tallest in their row; what it does not do is distribute what is *inside*
 * them, which is why the footers used to float at seven different heights.
 *
 * The surface carries no buttons. It had four on every card — twenty-eight on
 * a roster of seven — for actions taken once in a while, and the one thing
 * people actually come here to do was one of them rather than the card itself.
 * Now the card opens the editor and the rest live behind `⋯`.
 *
 * There is no Delete. An agent is named in the `roster_snapshot` of every
 * mission it ran, so removing the row would leave those replays describing
 * someone who is not there — which is why soft delete was chosen in §5.2.
 * Archive is the honest verb for "out of the way", and it is reversible.
 */
function AgentCard({ agent, onEdit }: { agent: Agent; onEdit: () => void }) {
  const { duplicate, archive, restore } = useAgentStore();
  const archived = agent.archivedAt !== null;

  // "UX/UI Designer" under "UX/UI Designer" is one fact printed twice. Compared
  // loosely, because "Tester (QA Engineer)" over "QA Engineer" is the same
  // repetition wearing brackets.
  const title = agent.title?.trim() ?? "";
  const name = agent.name.trim();
  const echoes =
    title !== "" &&
    (title.toLowerCase() === name.toLowerCase() ||
      name.toLowerCase().includes(title.toLowerCase()));

  const shown = agent.personalityTraits.slice(0, 3);
  const spare = agent.personalityTraits.length - shown.length;

  return (
    <div
      // Anywhere on the card opens the editor — it is the one thing people
      // come here to do. Clicks that started inside a nested control are left
      // alone: the `⋯` trigger, its menu items, and the name button all handle
      // themselves, and swallowing those would make the menu unopenable.
      //
      // A <button> around the whole card would be the tidier markup and is not
      // allowed: it would nest the menu button inside it, which no browser
      // permits and no screen reader announces sensibly. So the div carries the
      // pointer affordance and the name button carries the keyboard one.
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button,[role="menu"],a')) return;
        onEdit();
      }}
      // `group` so the menu can appear on hover; it is always reachable by
      // keyboard regardless, which is the part hover-reveal usually breaks.
      className={cn(
        // `min-w-0` is load-bearing: a grid item defaults to `min-width:auto`,
        // which refuses to shrink below its content, so at a narrow column the
        // traits and the model name ran straight out past the card's edge.
        "group grid h-full min-w-0 grid-rows-[auto_1fr_auto] gap-3 rounded-card border p-4",
        "cursor-pointer text-left transition-colors",
        archived
          ? "border-line bg-solid/40 opacity-60"
          : "border-line bg-solid hover:border-line-strong",
      )}
    >
      <div className="flex items-start gap-3">
        <Portrait avatar={agent.avatarConfig ?? null} name={agent.name} size={34} />

        {/* The name is the button. Making the whole card one would nest the
            menu inside it, which no browser allows and no screen reader can
            announce sensibly. */}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onEdit}
            className="block w-full min-w-0 text-left"
          >
            <span className="block truncate font-medium text-text">{agent.name}</span>
            {echoes ? null : (
              <span className="block truncate text-xs text-muted">{agent.title}</span>
            )}
          </button>
        </div>

        {archived ? <Badge tone="warn">{strings.roster.archived}</Badge> : null}

        <Menu
          // Named, because seven cards mean seven of these and "More options"
          // seven times tells a screen-reader user nothing about which.
          label={strings.roster.moreFor(agent.name)}
          trigger={<MoreIcon />}
          align="start"
          className={cn(
            "shrink-0 transition-opacity",
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          items={[
            {
              label: strings.roster.edit,
              onSelect: onEdit,
            },
            {
              label: strings.roster.duplicate,
              hint: strings.roster.duplicateHint,
              onSelect: () => void duplicate(agent.id),
            },
            archived
              ? { label: strings.roster.restore, onSelect: () => void restore(agent.id) }
              : {
                  label: strings.roster.archive,
                  hint: strings.roster.archiveHint,
                  onSelect: () => void archive(agent.id),
                },
          ]}
        />
      </div>

      {/* 1fr: this is the row that absorbs the difference in length. */}
      <div className="min-h-0 space-y-2">
        <p className="line-clamp-3 text-xs text-muted">{agent.role}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {shown.map((trait) => (
            <Badge key={trait}>{trait}</Badge>
          ))}
          {spare > 0 ? (
            <span
              className="shrink-0 text-[11px] text-faint"
              title={agent.personalityTraits.join(", ")}
            >
              +{spare}
            </span>
          ) : null}
        </div>
      </div>

      {/* Facts only: what it runs on, and what it has actually done (§1.1). */}
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px] text-faint">
        <span className="shrink-0">{strings.roster.missions(agent.totalMissions)}</span>
        {/* `min-w-0` again: without it `truncate` has nothing to truncate
            against and the model id pushes the row wider than the card. */}
        <span className="min-w-0 truncate font-mono">{agent.model ?? "—"}</span>
      </div>
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

  // The `key` below is the whole fix for a scroll bug. Both branches of this
  // component render a <div> in the same position, so React reconciles them to
  // the *same DOM node* and only swaps the children — and `scrollTop` is DOM
  // state, not a prop, so it survives the swap. Pressing Edit from a scrolled
  // roster dropped you at the bottom of the form, below the name field. A
  // distinct key makes it a different element, mounted fresh at the top.
  if (creating || editing) {
    return (
      <div key="agent-form" className="h-full overflow-y-auto">
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
        <h2 className="text-sm font-medium text-text">
          {strings.roster.title}
        </h2>
        <div className="flex items-center gap-3">
          <Checkbox
            checked={showArchived}
            onChange={setShowArchived}
            label={strings.roster.showArchived}
          />
          <Button onClick={() => setCreating(true)}>{strings.roster.create}</Button>
        </div>
      </div>

      <div key="agent-list" className="flex-1 overflow-y-auto p-4">
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
