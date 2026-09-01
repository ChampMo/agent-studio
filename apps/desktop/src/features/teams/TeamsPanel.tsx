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
import type { Team } from "../../transport/rest";
import { TeamBuilder } from "./TeamBuilder";

function TeamCard({ team, onEdit }: { team: Team; onEdit: () => void }) {
  const { duplicate, archive, restore, remove, exportTeam } = useTeamStore();
  const archived = team.archivedAt !== null;
  const [confirming, setConfirming] = useState(false);
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
          <div className="truncate font-medium text-slate-100">{team.name}</div>
          <div className="truncate text-xs text-slate-500">
            {team.members.length} {strings.teams.members} · {team.sceneLayoutId}
          </div>
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
      </div>

      <div className="flex flex-wrap gap-1">
        {team.members.map((m) => (
          <Badge key={m.agentId} tone={m.agentArchived ? "bad" : "neutral"}>
            {m.roleInTeam === "leader" ? "★ " : ""}
            {m.agentName ?? m.agentId}
          </Badge>
        ))}
      </div>

      {errors.length > 0 ? (
        <ul className="space-y-0.5 text-[11px] text-red-300">
          {errors.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="space-y-0.5 text-[11px] text-amber-400/80">
          {warnings.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-1 border-t border-slate-800 pt-2">
        <Button variant="ghost" onClick={onEdit}>
          {strings.teams.edit}
        </Button>
        <Button variant="ghost" onClick={() => duplicate(team.id)}>
          {strings.teams.duplicate}
        </Button>
        {/* Exportable even when it cannot run (§5.3). */}
        <Button variant="ghost" onClick={download}>
          {strings.teams.export}
        </Button>
        {archived ? (
          <Button variant="ghost" onClick={() => restore(team.id)}>
            {strings.teams.restore}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => archive(team.id)}>
            {strings.teams.archive}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setConfirming((v) => !v)}>
          {strings.teams.delete}
        </Button>
      </div>

      {confirming ? (
        <div className="space-y-2 rounded-md border border-red-900/60 bg-red-950/30 p-3">
          {/* The agents are not touched, and neither are the runs: a mission
              froze its roster at launch (§5.1). What goes is the arrangement. */}
          <p className="text-xs text-red-300">{strings.teams.deleteWarning}</p>
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => remove(team.id)}>
              {strings.teams.deleteConfirm}
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {strings.teams.title}
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {strings.teams.showArchived}
          </label>
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
