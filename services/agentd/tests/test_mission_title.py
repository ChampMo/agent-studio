"""A run has a name and an instruction, and they are not the same string (§18.2).

One column used to do both jobs. That works while a run *is* one instruction,
and stops the moment the run is a conversation: the first thing typed becomes
the instruction, and it is a sentence — often a paragraph — not a name. The
history list was showing whole briefs as titles.

The half worth a test is the old rows. Every mission recorded before migration
0010 has `title = NULL`, and the list falls back to the goal for those, because
the goal is what they were called at the time. Backfilling a title would be
writing something into the record that was never true of it (§5.1).
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select

from agentd.agents.runner import MissionRunner
from agentd.db.models import Agent, Mission, ProviderProfile, Team, TeamMember


async def _do_nothing(*args, **kwargs) -> None:
    """The run itself is not what these tests are about."""


async def seed_team(db) -> None:
    async with db.session() as s:
        s.add(
            ProviderProfile(
                id="prov-1",
                name="fake",
                kind="openai_compatible",
                base_url="http://localhost:1",
                model="m1",
                created_at=datetime.now(UTC),
            )
        )
        await s.flush()
        s.add(
            Agent(
                id="a-lead",
                name="Lead",
                provider_id="prov-1",
                model="m1",
                tools=[],
                avatar_config={},
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
        s.add(
            Team(
                id="t-1",
                name="Cell",
                scene_layout_id="war_room",
                emblem_config={},
                default_budget={},
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
        s.add(
            TeamMember(
                team_id="t-1", agent_id="a-lead", seat_index=0, role_in_team="leader"
            )
        )
        await s.commit()


async def _mission(db, mission_id: str) -> Mission:
    async with db.session() as s:
        return (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()


async def test_the_title_and_the_instruction_are_stored_separately(
    db, bus, monkeypatch
):
    await seed_team(db)
    runner = MissionRunner(db, bus)
    monkeypatch.setattr(runner, "_run_team", _do_nothing)

    mission_id = await runner.start_mission(
        team_id="t-1",
        title="Landing page",
        goal="Build a landing page for a premium gaming gear brand, dark mode.",
    )

    mission = await _mission(db, mission_id)
    assert mission.title == "Landing page"
    assert mission.goal.startswith("Build a landing page")


async def test_a_run_started_without_a_title_keeps_none(db, bus, monkeypatch):
    # Null, not the goal copied into it. The fallback is the reader's job, and
    # writing the goal in here would make an untitled run indistinguishable
    # from one somebody named after its own instruction.
    await seed_team(db)
    runner = MissionRunner(db, bus)
    monkeypatch.setattr(runner, "_run_team", _do_nothing)

    mission_id = await runner.start_mission(team_id="t-1", goal="Think about it.")

    assert (await _mission(db, mission_id)).title is None


async def test_an_empty_title_is_stored_as_none(db, bus, monkeypatch):
    # "" and "no title" are the same thing to a reader, so they are the same
    # thing in the column — otherwise the fallback has two cases to handle and
    # one of them will be missed.
    await seed_team(db)
    runner = MissionRunner(db, bus)
    monkeypatch.setattr(runner, "_run_team", _do_nothing)

    mission_id = await runner.start_mission(team_id="t-1", title="", goal="Go.")

    assert (await _mission(db, mission_id)).title is None
