"""Resolve a team into the config a mission actually runs with (§5.1).

This is the most load-bearing idea in the data model. Teams reference agents
live and there is no versioning, so an agent edited after a run would rewrite
history: the replay would show today's name, today's avatar, today's model. Worse,
removing a member would erase which seat they sat in, and the scene would have
nowhere to draw them.

So a mission freezes its roster at launch. **While a mission runs — and forever
afterwards, when it replays — nothing may read `agents` or `team_members`.** The
snapshot is the only source. `SnapshotMember.of()` is the one place that reads
those tables, and it runs exactly once per mission.

The snapshot is also where `team_members.overrides` disappears into: it holds the
*effective* config, already merged. Otherwise the timeline would report an
agent's default model while the request went out with an override, which is the
kind of quiet lie §1 rules out.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from ..db.models import Agent, Team, TeamMember


@dataclass(frozen=True)
class SnapshotMember:
    agent_id: str
    name: str
    seat_index: int
    role_in_team: str
    system_prompt: str
    provider_id: str | None
    model: str | None
    sampling: dict[str, Any] | None
    tools: list[str]
    avatar_config: dict[str, Any]
    title: str = ""
    role: str = ""
    #: When this member's tool calls stop to ask (§16.4). Frozen with the rest:
    #: a replay has to say how much the agent was trusted *then*, not now.
    autonomy: str = "ask_dangerous"

    @property
    def is_leader(self) -> bool:
        return self.role_in_team == "leader"

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SnapshotMember:
        known = {f for f in cls.__dataclass_fields__}
        # Unknown keys are dropped rather than fatal: a mission written by a
        # newer build must still replay here (§8).
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class RosterSnapshot:
    members: list[SnapshotMember] = field(default_factory=list)
    #: The folder this mission's file tools may touch (§16.2). Frozen here so a
    #: replay can answer "where was it writing?" — the mission row can be read
    #: for the live answer, but the snapshot is what the timeline is built from.
    workspace_root: str | None = None

    @property
    def leader(self) -> SnapshotMember | None:
        return next((m for m in self.members if m.is_leader), None)

    @property
    def workers(self) -> list[SnapshotMember]:
        return [m for m in self.members if not m.is_leader]

    def by_seat(self, seat_index: int) -> SnapshotMember | None:
        return next((m for m in self.members if m.seat_index == seat_index), None)

    def by_agent(self, agent_id: str) -> SnapshotMember | None:
        return next((m for m in self.members if m.agent_id == agent_id), None)

    def to_json(self) -> list[dict[str, Any]]:
        """The stored form: a list of members, each carrying the workspace.

        A list rather than an object because that is what `roster_snapshot` has
        held since migration 0001 and the column is full of real missions. The
        workspace rides on each member — repetitive, but it keeps every row
        readable by the build that wrote it and by this one (§8).
        """
        return [{**m.to_json(), "workspace_root": self.workspace_root} for m in self.members]

    @classmethod
    def from_json(cls, data: list[dict[str, Any]] | None) -> RosterSnapshot:
        rows = data or []
        workspace = next(
            (row.get("workspace_root") for row in rows if row.get("workspace_root")),
            None,
        )
        return cls([SnapshotMember.from_json(d) for d in rows], workspace_root=workspace)


def resolve(
    *,
    team: Team,
    members: list[TeamMember],
    agents: dict[str, Agent],
    workspace_root: str | None = None,
) -> RosterSnapshot:
    """Merge agents with their per-team overrides, once, at launch.

    Called from exactly one place — the mission runner, before the first event
    is published. After this returns, the tables it read are irrelevant to the
    mission.
    """
    del team  # kept in the signature so the caller cannot forget which team
    resolved: list[SnapshotMember] = []

    for member in sorted(members, key=lambda m: m.seat_index):
        agent = agents.get(member.agent_id)
        if agent is None:
            continue
        overrides = member.overrides or {}

        prompt = agent.system_prompt
        suffix = overrides.get("prompt_suffix")
        if suffix:
            prompt = f"{prompt}\n\n{suffix}".strip()

        tool_subset = overrides.get("tool_subset")

        resolved.append(
            SnapshotMember(
                agent_id=agent.id,
                name=agent.name,
                title=agent.title,
                role=agent.role,
                seat_index=member.seat_index,
                role_in_team=member.role_in_team,
                system_prompt=prompt,
                provider_id=agent.provider_id,
                # The override wins, and the snapshot records the winner. The
                # timeline then reports what actually ran.
                model=overrides.get("model") or agent.model,
                sampling=overrides.get("sampling", agent.sampling),
                tools=list(tool_subset) if tool_subset is not None else list(agent.tools),
                autonomy=overrides.get("autonomy") or agent.autonomy,
                avatar_config=dict(agent.avatar_config),
            )
        )

    return RosterSnapshot(resolved, workspace_root=workspace_root)
