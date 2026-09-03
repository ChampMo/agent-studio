/**
 * The team library (PROJECT_BRIEF.md §11, §12 M3).
 *
 * Every card says whether the team can run and why not, using the findings the
 * backend's single validator produced. Nothing here decides that for itself.
 */
import { useEffect, useRef, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { useTeamStore } from "../../stores/teamStore";
import { Badge, Button } from "../../components/ui/primitives";
import { Menu } from "../../components/ui/Menu";
import { MoreIcon } from "../../components/ui/icons";
import { cn } from "../../lib/cn";
import { Checkbox } from "../../components/ui/Checkbox";
import type { Team } from "../../transport/rest";
import { TeamBuilder } from "./TeamBuilder";

function TeamCard({ team, onEdit }: { team: Team; onEdit: () => void }) {
  const { duplicate, archive, restore, exportTeam } = useTeamStore();
  const archived = team.archivedAt !== null;
  const errors = team.findings.filter((f) => f.severity === "error");
  const warnings = team.findings.filter((f) => f.severity === "warn");

  async function download() {
    const document = await exportTeam(team.id);
    const blob = new Blob([JSON.stringify(document, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(window.document.createElement("a"), {
      href: url,
      download: `${team.name.replace(/[^\w-]+/g, "-").toLowerCase()}.team.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  const shownMembers = team.members.slice(0, 4);
  const spareMembers = team.members.length - shownMembers.length;
  const allFindings = [...errors, ...warnings];
  const shownFindings = allFindings.slice(0, 2);
  const spareFindings = allFindings.length - shownFindings.length;

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
      // Same three rows as an agent card, for the same reason: grid stretches
      // the cards, it does not distribute what is inside them.
      className={cn(
        // See the agent card: a grid item will not shrink below its content
        // without this, and the member badges overflow the card.
        "group grid h-full min-w-0 grid-rows-[auto_1fr_auto] gap-3 rounded-card border p-4",
        "cursor-pointer transition-colors",
        archived
          ? "border-line bg-solid/40 opacity-60"
          : "border-line bg-solid hover:border-line-strong",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onEdit} className="block w-full text-left">
            <span className="block truncate font-medium text-text">{team.name}</span>
            {/* The layout id was metadata joined by a middot, next to a member
                count the list of members below already gives you. Only the
                layout is left, because it is the one fact not shown elsewhere. */}
            <span className="block truncate text-xs text-faint">
              {team.sceneLayoutId}
            </span>
          </button>
        </div>

        {/* canRun comes from the backend and is defined as "no error in
            findings" — the same list the launcher will use (§5.2). */}
        <Badge tone={archived ? "warn" : team.canRun ? "good" : "bad"}>
          {archived
            ? strings.teams.archived
            : team.canRun
              ? strings.teams.ready
              : strings.teams.blocked}
        </Badge>

        <Menu
          label={strings.teams.moreFor(team.name)}
          trigger={<MoreIcon />}
          className={cn(
            "shrink-0 transition-opacity",
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          items={[
            { label: strings.teams.edit, onSelect: onEdit },
            { label: strings.teams.duplicate, onSelect: () => void duplicate(team.id) },
            // Exportable even when it cannot run (§5.3).
            { label: strings.teams.export, onSelect: download },
            archived
              ? { label: strings.teams.restore, onSelect: () => void restore(team.id) }
              : {
                  label: strings.teams.archive,
                  hint: strings.teams.archiveHint,
                  onSelect: () => void archive(team.id),
                },
          ]}
        />
      </div>

      <div className="min-h-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {shownMembers.map((m) => (
            <Badge key={m.agentId} tone={m.agentArchived ? "bad" : "neutral"}>
              {m.roleInTeam === "leader" ? "★ " : ""}
              {m.agentName ?? m.agentId}
            </Badge>
          ))}
          {spareMembers > 0 ? (
            <span
              className="shrink-0 text-[11px] text-faint"
              title={team.members.map((m) => m.agentName ?? m.agentId).join(", ")}
            >
              +{spareMembers}
            </span>
          ) : null}
        </div>

        {/* Why it cannot run, capped. A team with six findings used to print
            all six and tower over its neighbours; the rest are in the builder,
            which is where they get fixed. */}
        {shownFindings.map((f, i) => (
          <p
            key={i}
            className={cn(
              "text-[11px]",
              f.severity === "error" ? "text-stop" : "text-wait",
            )}
          >
            {f.message}
          </p>
        ))}
        {spareFindings > 0 ? (
          <p className="text-[11px] text-faint">
            {strings.teams.moreFindings(spareFindings)}
          </p>
        ) : null}
      </div>

      <div className="flex items-baseline justify-between gap-2 text-[11px] text-faint">
        <span>{strings.teams.memberCount(team.members.length)}</span>
      </div>
    </div>
  );
}

export function TeamsPanel() {
  const { teams, loading, error, showArchived, lastImportDuplicateOf } =
    useTeamStore();
  const { load, setShowArchived, importTeam } = useTeamStore();
  const [editing, setEditing] = useState<Team | null | "new">(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  if (editing !== null) {
    return (
      <TeamBuilder
        team={editing === "new" ? null : editing}
        onDone={() => {
          setEditing(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-medium text-text">
          {strings.teams.title}
        </h2>
        <div className="flex items-center gap-3">
          <Checkbox
            checked={showArchived}
            onChange={setShowArchived}
            label={strings.teams.showArchived}
          />
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await importTeam(JSON.parse(await file.text()));
              e.target.value = "";
            }}
          />
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            {strings.teams.import}
          </Button>
          <Button onClick={() => setEditing("new")}>{strings.teams.create}</Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error ? (
          <p className="mb-3 rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}

        {lastImportDuplicateOf ? (
          // New ids are always created, so the honest thing is to say a copy
          // was made rather than let the user wonder why there are two (§5.3).
          <p className="mb-3 rounded-md bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            {strings.teams.importedBefore}
          </p>
        ) : null}

        {!loading && teams.length === 0 ? (
          <p className="text-sm text-slate-500">{strings.teams.empty}</p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {teams.map((team) => (
            <TeamCard key={team.id} team={team} onEdit={() => setEditing(team)} />
          ))}
        </div>
      </div>
    </div>
  );
}
