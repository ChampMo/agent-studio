/**
 * Team builder: roster on the left, seats on the right (PROJECT_BRIEF.md §11).
 *
 * Drag works, and so does clicking — drag-only would make the feature
 * unreachable by keyboard, and the seats are small targets besides.
 *
 * Findings are rendered where they belong: a problem about a member is shown on
 * that member's seat, not only in a list the user has to match up by hand. They
 * come from the backend's single validator (§5.2); nothing here re-decides what
 * counts as a blocker.
 */
import { useEffect, useMemo, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useAgentStore } from "../../stores/agentStore";
import { useTeamStore } from "../../stores/teamStore";
import { Badge, Button, Field, Input } from "../../components/ui/primitives";
import type { Finding, Team, TeamMemberInput } from "../../transport/rest";

interface Props {
  team: Team | null;
  onDone: () => void;
}

export function TeamBuilder({ team, onDone }: Props) {
  const agents = useAgentStore((s) => s.agents);
  const loadAgents = useAgentStore((s) => s.load);
  const { layouts, create, update } = useTeamStore();

  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [layoutId, setLayoutId] = useState(team?.sceneLayoutId ?? layouts[0]?.id ?? "");
  const [seats, setSeats] = useState<(TeamMemberInput | null)[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>(team?.findings ?? []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const layout = layouts.find((l) => l.id === layoutId) ?? layouts[0];
  const seatCount = layout?.seats ?? 0;

  // Rebuild the seat array whenever the layout changes: a smaller layout has
  // nowhere to put the members that fall off the end, and silently dropping
  // them would lose work without saying so.
  useEffect(() => {
    setSeats((prev) => {
      const next: (TeamMemberInput | null)[] = Array.from(
        { length: seatCount },
        (_, i) => prev[i] ?? null,
      );
      if (prev.length === 0 && team) {
        for (const m of team.members) {
          if (m.seatIndex < seatCount) {
            next[m.seatIndex] = {
              agent_id: m.agentId,
              seat_index: m.seatIndex,
              role_in_team: m.roleInTeam,
              overrides: m.overrides,
            };
          }
        }
      }
      return next;
    });
  }, [seatCount, team]);

  const seated = useMemo(
    () => new Set(seats.filter(Boolean).map((s) => s!.agent_id)),
    [seats],
  );
  const displaced = team
    ? team.members.filter((m) => m.seatIndex >= seatCount).length
    : 0;

  function assign(index: number, agentId: string) {
    setSeats((prev) => {
      const next = [...prev];
      // An agent sits in one seat per team: moving them vacates the old one.
      for (let i = 0; i < next.length; i += 1) {
        if (next[i]?.agent_id === agentId) next[i] = null;
      }
      const hasLeader = next.some((s) => s?.role_in_team === "leader");
      next[index] = {
        agent_id: agentId,
        seat_index: index,
        // The first person seated becomes the leader. Exactly one is required
        // to run (§5.2), and defaulting saves the user a step they would
        // otherwise only discover from an error.
        role_in_team: hasLeader ? "member" : "leader",
        overrides: null,
      };
      return next;
    });
  }

  function clear(index: number) {
    setSeats((prev) => {
      const next = [...prev];
      const removed = next[index];
      next[index] = null;
      // Removing the leader promotes whoever is left, rather than leaving the
      // team in a state that cannot run without explaining why.
      if (removed?.role_in_team === "leader") {
        const first = next.findIndex(Boolean);
        if (first !== -1) next[first] = { ...next[first]!, role_in_team: "leader" };
      }
      return next;
    });
  }

  function makeLeader(index: number) {
    setSeats((prev) =>
      prev.map((s, i) =>
        s ? { ...s, role_in_team: i === index ? "leader" : "member" } : s,
      ),
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const members = seats.filter(Boolean).map((s, _i) => s!) as TeamMemberInput[];
    const payload = {
      name: name.trim(),
      description,
      scene_layout_id: layoutId,
      members,
    };
    try {
      // Saving is allowed even with errors: a half-built team is a normal
      // state, and refusing the save would throw the work away (§5.2).
      const saved = team ? await update(team.id, payload) : await create(payload);
      setFindings(saved.findings);
      if (saved.canRun) onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const bySubject = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const f of findings) {
      if (!f.subject) continue;
      map.set(f.subject, [...(map.get(f.subject) ?? []), f]);
    }
    return map;
  }, [findings]);
  const general = findings.filter((f) => !f.subject);

  return (
    <form onSubmit={save} className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {team ? strings.teams.editTitle : strings.teams.newTitle}
        </h2>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !name.trim()}>
            {strings.teams.save}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {strings.teams.close}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] divide-x divide-slate-800">
        {/* Roster */}
        <div className="min-h-0 overflow-y-auto p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {strings.teams.roster}
          </div>
          {agents.length === 0 ? (
            <p className="text-xs text-slate-500">{strings.teams.noAgents}</p>
          ) : null}
          <div className="space-y-1.5">
            {agents.map((agent) => {
              const used = seated.has(agent.id);
              return (
                <div
                  key={agent.id}
                  draggable
                  onDragStart={() => setDragging(agent.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => {
                    const free = seats.findIndex((s) => s === null);
                    if (free !== -1) assign(free, agent.id);
                  }}
                  className={cn(
                    "cursor-pointer rounded-md border px-2 py-1.5 text-xs",
                    used
                      ? "border-sky-800 bg-sky-950/40 text-sky-200"
                      : "border-slate-800 bg-slate-900/60 text-slate-200 hover:border-slate-700",
                  )}
                >
                  <div className="truncate font-medium">{agent.name}</div>
                  <div className="truncate text-[11px] text-slate-500">
                    {agent.title || agent.role}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Seats */}
        <div className="min-h-0 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={strings.teams.nameLabel}>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label={strings.teams.layoutLabel}>
              <select
                value={layoutId}
                onChange={(e) => setLayoutId(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                {layouts.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} · {l.seats} seats
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={strings.teams.descriptionLabel}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          {displaced > 0 ? (
            <p className="rounded-md bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              {strings.teams.displaced(displaced)}
            </p>
          ) : null}

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {strings.teams.seats}
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {seats.map((seat, index) => {
                const agent = agents.find((a) => a.id === seat?.agent_id);
                const problems = seat ? (bySubject.get(seat.agent_id) ?? []) : [];
                const worst = problems.some((p) => p.severity === "error")
                  ? "error"
                  : problems.length
                    ? "warn"
                    : null;
                return (
                  <div
                    key={index}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragging) assign(index, dragging);
                      setDragging(null);
                    }}
                    className={cn(
                      "min-h-[76px] rounded-md border p-2 text-xs transition-colors",
                      !seat && "border-dashed border-slate-800 text-slate-600",
                      seat && worst === "error" && "border-red-800 bg-red-950/30",
                      seat && worst === "warn" && "border-amber-800 bg-amber-950/20",
                      seat && !worst && "border-slate-700 bg-slate-900/60",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between text-[10px] uppercase text-slate-600">
                      <span>
                        {strings.teams.seat} {index}
                      </span>
                      {seat?.role_in_team === "leader" ? (
                        <Badge tone="good">{strings.teams.leader}</Badge>
                      ) : null}
                    </div>

                    {seat ? (
                      <>
                        <div className="truncate font-medium text-slate-100">
                          {agent?.name ?? seat.agent_id}
                        </div>
                        {problems.map((p, i) => (
                          <div
                            key={i}
                            className={cn(
                              "mt-1 text-[11px]",
                              p.severity === "error"
                                ? "text-red-300"
                                : "text-amber-300",
                            )}
                          >
                            {p.message}
                          </div>
                        ))}
                        <div className="mt-1.5 flex gap-1">
                          {seat.role_in_team !== "leader" ? (
                            <button
                              type="button"
                              onClick={() => makeLeader(index)}
                              className="text-[11px] text-sky-400 hover:underline"
                            >
                              {strings.teams.makeLeader}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => clear(index)}
                            className="text-[11px] text-slate-400 hover:underline"
                          >
                            {strings.teams.clearSeat}
                          </button>
                        </div>
                      </>
                    ) : (
                      <span>{strings.teams.emptySeat}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {general.length > 0 ? (
            <ul className="space-y-1">
              {general.map((f, i) => (
                <li
                  key={i}
                  className={cn(
                    "rounded-md px-3 py-2 text-xs",
                    f.severity === "error"
                      ? "bg-red-950/40 text-red-300"
                      : "bg-amber-950/30 text-amber-300",
                  )}
                >
                  {f.message}
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p className="rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
