"""Deleting things for good, and what that must not break.

Archiving is still the default and still the right one. What these tests pin is
the part that makes a real delete safe at all: **a finished mission holds its
own copy of who ran it** (§5.1). Delete the agent, delete the team, and the
replay still shows the name, the model and the seat that did the work — because
nothing past the launch boundary ever reads those tables.

Deleting a mission is the exception to "mission_events is append-only forever"
(§2, §5). The rule is there so nothing rewrites what happened; removing a whole
run at the user's request is tearing the page out, not altering it. Single
events still cannot be touched, and a mission that is still going is refused.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from agentd.agents.service import AgentNotFound, AgentService
from agentd.artifacts.store import ArtifactStore
from agentd.core import auth, config
from agentd.db.models import Agent, Mission, MissionEvent, Team, TeamMember
from agentd.main import create_app
from agentd.teams.service import TeamService

TOKEN = "test-token"


@pytest.fixture
def client(db, tmp_path):
    auth.set_token(TOKEN)
    app = create_app(settings=config.Settings(data_dir=tmp_path), db=db)
    with TestClient(app) as running:
        yield running


def headers() -> dict[str, str]:
    return {"X-Agent-Studio-Token": TOKEN}


async def seed(db) -> None:
    now = datetime.now(UTC)
    async with db.session() as s:
        s.add(
            Agent(
                id="a-1",
                name="Mira",
                model="m1",
                tools=["read_file"],
                avatar_config={"body": "slim"},
                created_at=now,
                updated_at=now,
            )
        )
        await s.flush()
        s.add(
            Team(
                id="t-1",
                name="Cell",
                scene_layout_id="war_room",
                emblem_config={},
                default_budget={},
                created_at=now,
                updated_at=now,
            )
        )
        s.add(TeamMember(team_id="t-1", agent_id="a-1", seat_index=0, role_in_team="leader"))
        # A finished mission that used them both, with its roster frozen.
        s.add(
            Mission(
                id="m-1",
                kind="mission",
                team_id="t-1",
                goal="Do the thing.",
                status="ended",
                end_reason="completed",
                budget={},
                roster_snapshot=[
                    {
                        "agent_id": "a-1",
                        "name": "Mira",
                        "seat_index": 0,
                        "role_in_team": "leader",
                        "model": "m1",
                        "tools": ["read_file"],
                        "avatar_config": {"body": "slim"},
                    }
                ],
                started_at=now,
            )
        )
        await s.commit()


async def test_deleting_an_agent_does_not_rewrite_a_finished_mission(db):
    """The whole reason a real delete is safe (§5.1)."""
    await seed(db)
    await AgentService(db).delete("a-1")

    async with db.session() as s:
        gone = (await s.execute(select(Agent).where(Agent.id == "a-1"))).scalar_one_or_none()
        mission = (await s.execute(select(Mission).where(Mission.id == "m-1"))).scalar_one()
        seats = list(
            (await s.execute(select(TeamMember).where(TeamMember.agent_id == "a-1")))
            .scalars()
            .all()
        )

    assert gone is None
    # The seat goes with the agent — a team cannot hold a member that is not
    # there — and the validator already reports a team that is short.
    assert seats == []
    # But the record of what happened is untouched.
    assert mission.roster_snapshot[0]["name"] == "Mira"
    assert mission.roster_snapshot[0]["model"] == "m1"


async def test_deleting_a_team_leaves_the_missions_it_ran(db):
    await seed(db)
    await TeamService(db).delete("t-1")

    async with db.session() as s:
        gone = (await s.execute(select(Team).where(Team.id == "t-1"))).scalar_one_or_none()
        mission = (await s.execute(select(Mission).where(Mission.id == "m-1"))).scalar_one()

    assert gone is None
    # Left pointing at an id that no longer resolves, on purpose: the mission
    # records which team ran it, and nulling that to keep a key tidy would be
    # editing history.
    assert mission.team_id == "t-1"


async def test_deleting_an_agent_that_is_not_there_says_so(db):
    with pytest.raises(AgentNotFound):
        await AgentService(db).delete("nobody")


async def test_deleting_a_mission_takes_its_events_and_files(db, client, tmp_path):
    await seed(db)
    async with db.session() as s:
        s.add(
            MissionEvent(
                id="e-1",
                mission_id="m-1",
                seq=1,
                ts=datetime.now(UTC),
                v=1,
                type="mission.started",
                payload={"kind": "mission", "goal": "Do the thing."},
            )
        )
        await s.commit()

    import agentd.artifacts.store as store_mod

    store = ArtifactStore(db)
    artifact = await store.write_text(
        mission_id="m-1", agent_id="a-1", title="Answer", text="the answer"
    )
    on_disk = store_mod._safe("m-1", artifact.path)
    assert on_disk.is_file()

    removed = client.delete("/missions/m-1", headers=headers())
    assert removed.status_code == 204

    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == "m-1"))
        ).scalar_one_or_none()
        events = list(
            (await s.execute(select(MissionEvent).where(MissionEvent.mission_id == "m-1")))
            .scalars()
            .all()
        )
    assert mission is None
    assert events == []
    # The file goes too. A row deleted before its file leaves a file nothing
    # points at, which is worse than an orphaned row.
    assert not on_disk.exists()


async def test_a_running_mission_is_not_deleted_out_from_under_itself(db, client):
    await seed(db)
    async with db.session() as s:
        row = (await s.execute(select(Mission).where(Mission.id == "m-1"))).scalar_one()
        row.status = "running"
        await s.commit()

    runner = client.app.state.runner

    class Busy:
        def __contains__(self, key):  # pragma: no cover - trivial
            return True

    original = runner.is_running
    runner.is_running = lambda mission_id: mission_id == "m-1"
    try:
        refused = client.delete("/missions/m-1", headers=headers())
    finally:
        runner.is_running = original

    # Cancel it first, so it ends with the `mission.ended` every mission is
    # promised rather than vanishing mid-flight.
    assert refused.status_code == 409
    assert "stop it" in refused.text


async def test_deleting_a_mission_that_is_not_there_is_a_404(db, client):
    assert client.delete("/missions/nope", headers=headers()).status_code == 404
