"""A file tool with no folder chosen has no boundary (§16.2, §12 M8 criterion 7).

The gate is at launch, in the same place and of the same kind as the team
validator: refusing later — when the model calls `read_file` and gets an error —
would mean the mission was started, paid for, and is now stuck on something the
user could have been asked about in advance.

The second half is the record. `workspace_root` is on the mission row, on the
frozen snapshot and on `mission.started`, so a replay of last week's run can say
where that work happened rather than where this build would put it today (§5.1).
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select

from agentd.agents.runner import MissionRejected, MissionRunner
from agentd.db.models import Agent, Mission, ProviderProfile, Team, TeamMember
from agentd.teams.snapshot import RosterSnapshot


async def seed_team(db, *, tools: list[str]) -> str:
    """One leader with the given tools, and a provider it can use."""
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
        # Flushed before the agent that points at it: the FK is enforced, and
        # within one flush the order is the unit of work's business, not ours.
        await s.flush()
        s.add(
            Agent(
                id="a-lead",
                name="Lead",
                provider_id="prov-1",
                model="m1",
                tools=tools,
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
            TeamMember(team_id="t-1", agent_id="a-lead", seat_index=0, role_in_team="leader")
        )
        await s.commit()
    return "t-1"


async def test_a_team_with_file_tools_cannot_start_without_a_workspace(db, bus):
    await seed_team(db, tools=["read_file"])
    runner = MissionRunner(db, bus)

    with pytest.raises(MissionRejected) as caught:
        await runner.start_mission(team_id="t-1", goal="Look around.")

    # Named, so the user is told which tools need it rather than that something
    # is wrong.
    assert any("read_file" in problem for problem in caught.value.problems)


async def test_a_team_with_no_file_tools_starts_without_one(db, bus, monkeypatch):
    # A researcher that only searches the web needs no folder, and demanding one
    # would be a gate that teaches people to pick a folder at random.
    await seed_team(db, tools=[])
    runner = MissionRunner(db, bus)
    monkeypatch.setattr(runner, "_run_team", _do_nothing)

    mission_id = await runner.start_mission(team_id="t-1", goal="Think.")
    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()
    assert mission.workspace_root is None


async def test_a_chosen_workspace_is_recorded_everywhere_a_replay_looks(
    db, bus, tmp_path: Path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    await seed_team(db, tools=["read_file"])
    runner = MissionRunner(db, bus)
    monkeypatch.setattr(runner, "_run_team", _do_nothing)

    mission_id = await runner.start_mission(
        team_id="t-1", goal="Read the code.", workspace_root=str(project)
    )

    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()

    resolved = str(project.resolve())
    assert mission.workspace_root == resolved
    # The snapshot, because that is what a replay is built from (§5.1).
    assert RosterSnapshot.from_json(mission.roster_snapshot).workspace_root == resolved

    events = await bus.history(mission_id, 0, 10**6)
    started = next(e for e in events if e["draft"]["type"] == "mission.started")
    assert started["draft"]["payload"]["workspaceRoot"] == resolved


async def test_a_workspace_that_is_not_a_folder_is_refused_at_launch(
    db, bus, tmp_path: Path
):
    # The picker validated it, and this validates it again: the path arrived
    # from a window, and this is the process that would act on it.
    await seed_team(db, tools=["read_file"])
    runner = MissionRunner(db, bus)

    with pytest.raises(MissionRejected):
        await runner.start_mission(
            team_id="t-1", goal="Read.", workspace_root=str(tmp_path / "not-there")
        )


async def test_a_used_workspace_joins_the_recent_list(db, bus, tmp_path: Path, monkeypatch):
    from agentd.tools.workspace import WorkspaceStore

    project = tmp_path / "used"
    project.mkdir()
    await seed_team(db, tools=["grep"])
    runner = MissionRunner(db, bus)
    monkeypatch.setattr(runner, "_run_team", _do_nothing)

    await runner.start_mission(team_id="t-1", goal="Search.", workspace_root=str(project))

    recent = await WorkspaceStore(db).recent()
    # Only after a mission used it: the list is of folders worked in, not
    # folders browsed to.
    assert [row["path"] for row in recent] == [str(project.resolve())]


async def _do_nothing(*args, **kwargs) -> None:
    """Stand in for the run itself; these tests are about the launch."""
    return None


async def test_a_mission_that_ends_stops_asking(db, bus):
    """A tool approval belongs to a live turn. When the mission ends — cancelled,
    or crashed with the process — the question goes with it, or the next client
    to start shows a modal whose answer comes back 409."""
    from datetime import UTC, datetime

    from agentd.db.models import Mission

    async with db.session() as s:
        s.add(
            Mission(
                id="m-stale",
                kind="mission",
                team_id=None,
                goal="g",
                status="running",
                budget={},
                roster_snapshot=[],
                pending_request="req-abandoned",
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()

    runner = MissionRunner(db, bus)
    assert await runner.reap_orphans() == 1

    # Nothing is waiting on anyone any more.
    assert await runner.pending_requests() == []
