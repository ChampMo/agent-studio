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
import { Select } from "../../components/ui/Select";
import { cn } from "../../lib/cn";
import { useAgentStore } from "../../stores/agentStore";
import { useTeamStore } from "../../stores/teamStore";
import { Button, Field, Input } from "../../components/ui/primitives";
import { Portrait } from "../../components/ui/Portrait";
import { MoreIcon, StarIcon } from "../../components/ui/icons";
import { Menu } from "../../components/ui/Menu";
import { MemberCard, useHoverCard } from "../shell/MemberCard";
import { api, type Agent, type TeamProposal } from "../../transport/rest";
import { TeamAdvisor } from "./TeamAdvisor";
import type {
  BudgetLimits,
  Finding,
  Team,
  TeamMemberInput,
} from "../../transport/rest";
import {
  BudgetOverrides,
  overridesFromBody,
  overridesToBody,
  type Overrides,
} from "../settings/BudgetOverrides";

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
  const [layoutId, setLayoutId] = useState(
    team?.sceneLayoutId ?? layouts[0]?.id ?? "",
  );
  const [seats, setSeats] = useState<(TeamMemberInput | null)[]>([]);
  //: What is being dragged, and from where. Two sources drop onto the same
  //: target and mean different things: a name from the roster *seats*
  //: somebody, a seat card *swaps* two desks. One string could not tell them
  //: apart, and a swap that lost a person is the worst outcome here.
  const [dragging, setDragging] = useState<
    { from: "roster"; agentId: string } | { from: "seat"; index: number } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>(team?.findings ?? []);
  //: Only the limits this team wants to differ on. Blank means the app's.
  const [budget, setBudget] = useState<Overrides>(
    overridesFromBody(
      team?.defaultBudget as Record<string, number> | undefined,
    ),
  );
  //: What a blank box is worth, shown as its placeholder so nobody has to work
  //: out what the team will actually run with.
  const [appBudget, setAppBudget] = useState<BudgetLimits | null>(null);

  useEffect(() => {
    void api
      .budget()
      .then((r) => setAppBudget(r.value))
      // A placeholder that could not be fetched is left blank rather than
      // guessed: a wrong inherited number is worse than none.
      .catch(() => setAppBudget(null));
  }, []);

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

  /**
   * Seat 0 leads, and every seat carries its own index.
   *
   * The role used to be a separate thing you set with a star, and the room
   * then had to work out where the leader was in order to give them the head
   * of the table. One fact in two places: the seat you are in, and whether you
   * are in charge. They are the same fact now.
   *
   * `seat_index` is rewritten from the position too, because a swap moves a
   * member without their old index being right any more — and that index is
   * what the whole scene indexes desks by.
   */
  //: The same card the run's rail shows, over the two places a person is
  //: named here. The source is different and the difference is real: the rail
  //: reads a mission's frozen snapshot, this reads the agents table, because
  //: a team being built runs in the future and will use whoever they are then.
  const card = useHoverCard();
  const cardFor = (agent: Agent, seatIndex: number) => ({
    agent_id: agent.id,
    name: agent.name,
    // -1 for the roster list: they are not seated, and any real number there
    // would be a claim about a seat they are not in.
    seat_index: seatIndex,
    role_in_team: seatIndex === 0 ? "leader" : "member",
    model: agent.model,
    avatar_config: agent.avatarConfig,
    tools: agent.tools,
    title: agent.title,
    role: agent.role,
  });

  function reseat(next: (TeamMemberInput | null)[]): (TeamMemberInput | null)[] {
    return next.map((s, i) =>
      s
        ? {
            ...s,
            seat_index: i,
            role_in_team: i === 0 ? "leader" : "member",
          }
        : null,
    );
  }

  function assign(index: number, agentId: string) {
    setSeats((prev) => {
      const next = [...prev];
      // An agent sits in one seat per team: moving them vacates the old one.
      for (let i = 0; i < next.length; i += 1) {
        if (next[i]?.agent_id === agentId) next[i] = null;
      }
      next[index] = {
        agent_id: agentId,
        seat_index: index,
        role_in_team: "member",
        overrides: null,
      };
      return reseat(next);
    });
  }

  /**
   * Take a proposal into the seats. Nothing is written.
   *
   * The tools it wants added become a per-team `tool_subset` override rather
   * than an edit to the agent: that agent is on other teams, and "this work
   * needs grep" is a fact about this team's job, not a permanent change to
   * somebody's toolbox (§5.1). The override is the agent's own tools plus the
   * additions, which is what the backend validated the proposal as.
   */
  function applyProposal(proposal: TeamProposal) {
    setLayoutId(proposal.layoutId);
    const width =
      layouts.find((l) => l.id === proposal.layoutId)?.seats ?? seats.length;
    const next: (TeamMemberInput | null)[] = Array(width).fill(null);
    for (const member of proposal.members) {
      if (member.seat >= width) continue;
      const agent = agents.find((a) => a.id === member.agentId);
      next[member.seat] = {
        agent_id: member.agentId,
        seat_index: member.seat,
        // Whatever the model said about roles, the seat decides. It is asked
        // to put its leader in seat 0 and `reseat` makes that true either way.
        role_in_team: "member",
        overrides:
          member.addTools.length > 0 && agent
            ? {
                tool_subset: [
                  ...new Set([...(agent.tools ?? []), ...member.addTools]),
                ].sort(),
              }
            : null,
      };
    }
    setSeats(reseat(next));
  }

  function clear(index: number) {
    setSeats((prev) => {
      const next = [...prev];
      next[index] = null;
      return reseat(next);
    });
  }

  /**
   * Move whoever is in `from` to `to`, and whoever was in `to` back.
   *
   * A swap, not an insert-and-shift: dropping onto an occupied desk means
   * "you two trade places", which is what the picture shows and the only
   * reading in which nobody can be pushed out of the last seat and lost.
   */
  function swap(from: number, to: number) {
    if (from === to) return;
    setSeats((prev) => {
      const next = [...prev];
      const a = next[from] ?? null;
      next[from] = next[to] ?? null;
      next[to] = a;
      return reseat(next);
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const members = seats
      .filter(Boolean)
      .map((s, _i) => s!) as TeamMemberInput[];
    const payload = {
      name: name.trim(),
      description,
      scene_layout_id: layoutId,
      members,
      // Only what was filled in. `resolve_limits` reads field by field, so a
      // team that only wants longer runs sends only `timeout_sec`.
      default_budget: overridesToBody(budget),
    };
    try {
      // Saving is allowed even with errors: a half-built team is a normal
      // state, and refusing the save would throw the work away (§5.2).
      const saved = team
        ? await update(team.id, payload)
        : await create(payload);
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
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-text">
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

      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] divide-x divide-line">
        {/* Roster */}
        <div className="min-h-0 overflow-y-auto p-3">
          <div className="mb-2 text-xs font-medium text-muted">
            {strings.teams.roster}
          </div>
          {agents.length === 0 ? (
            <p className="text-xs text-faint">{strings.teams.noAgents}</p>
          ) : null}
          <div className="space-y-1.5">
            {agents.map((agent) => {
              const used = seated.has(agent.id);
              return (
                <div
                  key={agent.id}
                  draggable
                  onMouseEnter={(e) => card.show(agent.id, e.currentTarget)}
                  onMouseLeave={card.hide}
                  onFocus={(e) => card.show(agent.id, e.currentTarget, true)}
                  onBlur={card.hide}
                  onDragStart={() =>
                    setDragging({ from: "roster", agentId: agent.id })
                  }
                  onDragEnd={() => setDragging(null)}
                  onClick={() => {
                    // A second click takes them back out. The list already
                    // shows who is seated, so clicking a seated name had to
                    // mean *something*, and "nothing" was the one option that
                    // made the highlight look broken.
                    const at = seats.findIndex((s) => s?.agent_id === agent.id);
                    if (at !== -1) {
                      clear(at);
                      return;
                    }
                    const free = seats.findIndex((s) => s === null);
                    if (free !== -1) assign(free, agent.id);
                  }}
                  // Says which of the two a click will do, since the same
                  // control does both.
                  title={
                    used
                      ? strings.teams.clickToRemove(agent.name)
                      : strings.teams.clickToSeat(agent.name)
                  }
                  className={cn(
                    "cursor-pointer rounded-md border px-2 py-1.5 text-xs",
                    used
                      ? "border-accent bg-accent/10 text-text"
                      : "border-line bg-solid text-text hover:border-line-strong",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Portrait
                      avatar={agent.avatarConfig ?? null}
                      name={agent.name}
                      size={26}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{agent.name}</div>
                      <div className="truncate text-[11px] text-faint">
                        {agent.title || agent.role}
                      </div>
                    </div>
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
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
            <Field label={strings.teams.layoutLabel}>
              <Select
                value={layoutId}
                onChange={setLayoutId}
                options={layouts.map((l) => ({
                  value: l.id,
                  label: l.name,
                  // The seat count was joined to the name by a middot. It is a
                  // different fact about the layout, so it reads as one.
                  hint: strings.teams.seatCount(l.seats),
                }))}
              />
            </Field>
          </div>

          <Field label={strings.teams.descriptionLabel}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          {displaced > 0 ? (
            <p className="rounded-md bg-attn-soft px-3 py-2 text-xs text-attn">
              {strings.teams.displaced(displaced)}
            </p>
          ) : null}

          {/* Folded away, because most teams want the app's limits and the
              seats are what this page is for. Open when this team already has
              one, so a saved override is never hidden from the person who set
              it. */}
          <details open={Object.keys(budget).length > 0}>
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-text">
              {strings.budget.teamTitle}
            </summary>
            <div className="pt-2">
              <BudgetOverrides
                values={budget}
                inherited={appBudget}
                onChange={setBudget}
                inheritedFrom={strings.budget.teamFrom}
              />
            </div>
          </details>

          {/* Folded: staffing a team by hand is the normal path and this is
              the shortcut. Open on a new team, where there is nothing on
              screen yet and a brief is the fastest way to a starting point. */}
          <details open={!team}>
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-text">
              {strings.advisor.title}
            </summary>
            <div className="pt-2">
              <TeamAdvisor
                teamId={team?.id ?? null}
                draft={seats
                  .filter((s): s is TeamMemberInput => s !== null)
                  .map((s) => ({
                    agent_id: s.agent_id,
                    seat_index: s.seat_index,
                    role_in_team: s.role_in_team,
                  }))}
                onApply={applyProposal}
              />
            </div>
          </details>

          <div>
            <div className="mb-2 text-xs font-medium text-muted">
              {strings.teams.seats}
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {seats.map((seat, index) => {
                const agent = agents.find((a) => a.id === seat?.agent_id);
                const problems = seat
                  ? (bySubject.get(seat.agent_id) ?? [])
                  : [];
                const worst = problems.some((p) => p.severity === "error")
                  ? "error"
                  : problems.length
                    ? "warn"
                    : null;
                return (
                  <div
                    key={index}
                    // Only an occupied seat can be picked up; an empty one has
                    // nothing to move.
                    draggable={Boolean(seat)}
                    onDragStart={() => {
                      // A card following the pointer during a drag is noise
                      // over the thing being dropped on.
                      card.hide();
                      if (seat) setDragging({ from: "seat", index });
                    }}
                    onDragEnd={() => setDragging(null)}
                    onMouseEnter={(e) =>
                      seat && !dragging && card.show(seat.agent_id, e.currentTarget)
                    }
                    onMouseLeave={card.hide}
                    // The pointer is still over the row when the `⋯` opens, so
                    // without this the card and the menu sit on screen at once
                    // arguing for the same space.
                    onMouseDown={card.hide}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragging?.from === "roster")
                        assign(index, dragging.agentId);
                      else if (dragging?.from === "seat")
                        swap(dragging.index, index);
                      setDragging(null);
                    }}
                    className={cn(
                      "relative min-h-[76px] rounded-md border p-2 text-xs transition-colors",
                      seat && "cursor-grab active:cursor-grabbing",
                      !seat && "border-dashed border-line text-faint",
                      seat && worst === "error" && "border-stop/40 bg-stop/10",
                      seat &&
                        worst === "warn" &&
                        "border-attn-edge bg-attn-soft",
                      seat && !worst && "border-line bg-solid",
                      // Being dragged, and the seat under the pointer.
                      dragging?.from === "seat" &&
                        dragging.index === index &&
                        "opacity-50",
                    )}
                  >
                    {/* Pinned to the seat, not to the person.

                        Seat 0 is the leader now — that is a property of the
                        desk, so the star sits on the desk and cannot be handed
                        around. It marks an empty seat 0 too, because the point
                        is to say what will happen when somebody is dropped
                        there, before they are.

                        Tilted, because a badge that is square to the card
                        reads as another control. This one is a sticker. */}
                    {index === 0 ? (
                      <span
                        aria-hidden="true"
                        title={strings.teams.seatZeroLeads}
                        className={cn(
                          "pointer-events-none absolute -right-1.5 -top-2 rotate-[18deg]",
                          "text-wait drop-shadow",
                        )}
                      >
                        <StarIcon size={20} filled />
                      </span>
                    ) : null}

                    <div className="mb-1 flex items-center justify-between text-[10px] text-faint">
                      <span>
                        {strings.teams.seat} {index}
                        {index === 0 ? (
                          // Said in words as well as with the sticker: colour
                          // and a shape alone are not a label (§18.3).
                          <span className="text-wait"> · {strings.teams.leads}</span>
                        ) : null}
                      </span>
                    </div>

                    {seat ? (
                      <>
                        <div className="flex min-w-0 items-start gap-2">
                          <Portrait
                            avatar={agent?.avatarConfig ?? null}
                            name={agent?.name ?? seat.agent_id}
                            size={24}
                          />
                          {/* The same two lines the roster list shows, so a
                              seat and the entry it came from read alike —
                              the seat had a name and then blank space where
                              the role was on the left. */}
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-text">
                              {agent?.name ?? seat.agent_id}
                            </div>
                            {agent?.title || agent?.role ? (
                              <div className="truncate text-[11px] text-faint">
                                {agent.title || agent.role}
                              </div>
                            ) : null}
                          </div>

                          {/* A menu, not a row of icons, and the reason is
                              the one the search-key chain already settled:
                              dragging is a mouse gesture, so a reorder that
                              exists only as a drag is a reorder some people
                              cannot perform at all (WCAG 2.1.1). Two menu
                              items are keyboard-reachable for free. */}
                          <Menu
                            label={strings.teams.moreForSeat(
                              agent?.name ?? seat.agent_id,
                            )}
                            trigger={<MoreIcon size={14} />}
                            className="shrink-0"
                            items={[
                              {
                                label: strings.teams.moveEarlier,
                                disabled: index === 0,
                                hint:
                                  index === 0
                                    ? strings.teams.alreadyFirstSeat
                                    : undefined,
                                onSelect: () => swap(index, index - 1),
                              },
                              {
                                label: strings.teams.moveLater,
                                disabled: index >= seats.length - 1,
                                hint:
                                  index >= seats.length - 1
                                    ? strings.teams.alreadyLastSeat
                                    : undefined,
                                onSelect: () => swap(index, index + 1),
                              },
                              {
                                label: strings.teams.clearSeat,
                                tone: "danger" as const,
                                onSelect: () => clear(index),
                              },
                            ]}
                          />
                        </div>
                        {problems.map((p, i) => (
                          <div
                            key={i}
                            className={cn(
                              "mt-1 text-[11px]",
                              p.severity === "error"
                                ? "text-stop"
                                : "text-attn",
                            )}
                          >
                            {p.message}
                          </div>
                        ))}
                      </>
                    ) : (
                      <span>{strings.teams.emptySeat}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* One card, wherever the pointer or the keyboard is. Seated or not
              is read from the seats, so a member who is on the grid shows
              which desk and a roster entry does not. */}
          {card.open
            ? (() => {
                const agent = agents.find((a) => a.id === card.open!.id);
                if (!agent) return null;
                const at = seats.findIndex((x) => x?.agent_id === agent.id);
                return (
                  <MemberCard
                    member={cardFor(agent, at)}
                    anchor={card.open!.el}
                  />
                );
              })()
            : null}

          {general.length > 0 ? (
            <ul className="space-y-1">
              {general.map((f, i) => (
                <li
                  key={i}
                  className={cn(
                    "rounded-md px-3 py-2 text-xs",
                    f.severity === "error"
                      ? "bg-stop/10 text-stop"
                      : "bg-attn-soft text-attn",
                  )}
                >
                  {f.message}
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p className="rounded-md bg-stop/10 px-3 py-2 text-sm text-stop">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
