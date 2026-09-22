"""The member in seat 0 leads, and nothing else decides it.

Two columns had been holding two halves of one fact — which desk somebody sits
at, and whether they are in charge — with nothing making them agree. They
didn't: a real five-person team on this machine had its leader in seat 4, so
the room seated the QA engineer at the head of the table.

`set_members` is the only door into `team_members` and both save and import go
through it, so the rule belongs there rather than in the client that happens to
be sending.
"""

from __future__ import annotations

import pytest

from agentd.agents.avatar import default_avatar
from agentd.agents.service import AgentService
from agentd.teams.service import TeamService


async def _team(db, name: str = "T") -> str:
    svc = TeamService(db)
    team = await svc.create({"name": name, "scene_layout_id": "open_desks"})
    return team.id


async def _agents(db, n: int) -> list[str]:
    """Real rows: `team_members.agent_id` is a foreign key."""
    svc = AgentService(db)
    out = []
    for i in range(n):
        agent = await svc.create(
            {
                "name": f"A{i}",
                "title": "Analyst",
                "role": "Finds things",
                "system_prompt": "Be careful.",
                "model": "m1",
                "avatar_config": default_avatar(),
            }
        )
        out.append(agent.id)
    return out


@pytest.mark.asyncio
async def test_seat_zero_becomes_the_leader(db) -> None:
    svc = TeamService(db)
    team_id = await _team(db)
    a, b = await _agents(db, 2)

    # Every member sent as a plain member: the client said nothing about who
    # leads, which is the shape the builder now sends.
    await svc.set_members(
        team_id,
        [
            {"agent_id": a, "seat_index": 0, "role_in_team": "member"},
            {"agent_id": b, "seat_index": 1, "role_in_team": "member"},
        ],
    )

    roles = {m.seat_index: m.role_in_team for m in await svc.members(team_id)}
    assert roles == {0: "leader", 1: "member"}


@pytest.mark.asyncio
async def test_the_seat_wins_over_what_was_sent(db) -> None:
    """An import is the other door, and it carries whatever the file said."""
    svc = TeamService(db)
    team_id = await _team(db)
    a, b, c = await _agents(db, 3)

    await svc.set_members(
        team_id,
        [
            {"agent_id": a, "seat_index": 0, "role_in_team": "member"},
            {"agent_id": b, "seat_index": 1, "role_in_team": "member"},
            # A file from an older build, naming seat 2 as the leader.
            {"agent_id": c, "seat_index": 2, "role_in_team": "leader"},
        ],
    )

    roles = {m.seat_index: m.role_in_team for m in await svc.members(team_id)}
    assert roles == {0: "leader", 1: "member", 2: "member"}
    # And exactly one, which is what the run gate requires (§5.2).
    assert sum(1 for r in roles.values() if r == "leader") == 1


@pytest.mark.asyncio
async def test_a_team_with_no_seat_zero_has_no_leader(db) -> None:
    """Half-built is a normal state. The builder allows saving it and the
    launcher refuses to run it — this must not invent a leader to paper over
    that, because the validator's `no_leader` is the message that explains it."""
    svc = TeamService(db)
    team_id = await _team(db)
    (b,) = await _agents(db, 1)

    await svc.set_members(
        team_id,
        [{"agent_id": b, "seat_index": 1, "role_in_team": "leader"}],
    )

    assert [m.role_in_team for m in await svc.members(team_id)] == ["member"]
