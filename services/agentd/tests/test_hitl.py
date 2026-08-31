"""M6 proof: an approval survives the app closing (§12 M6, §7).

The milestone's hard criterion is that a question can be answered *after a
restart*. That rules out holding the pause in memory, so the test does what the
criterion describes: it pauses a mission, throws away the runner that paused it,
builds a new one against the same database and checkpointer, and answers there.

The second runner stands in for the next launch of the app. If the pause lived
in the first runner's memory, every assertion after that point fails.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from sqlalchemy import select

from agentd.agents.runner import MissionRunner, RequestNotFound
from agentd.agents.service import AgentService
from agentd.artifacts.store import ArtifactRejected, ArtifactStore, _safe
from agentd.db.models import Mission, ProviderProfile
from agentd.orchestrator.hitl import APPROVE
from agentd.teams.service import TeamService

from .test_orchestrator import PLAN, TeamModel, roster_of_three


@pytest.fixture
def saver():
    """Shared between the two runners, exactly as the file on disk is shared
    between two launches of the app."""
    return InMemorySaver()


async def seed_mission(db, roster, goal="Investigate."):
    mission_id = "m-hitl"
    async with db.session() as s:
        # The snapshot's members name `prov-1`, and `_run_team` resolves the
        # provider from that id. Without the row the mission fails before it
        # ever reaches the approval gate.
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
        s.add(
            Mission(
                id=mission_id,
                kind="mission",
                team_id=None,
                goal=goal,
                status="running",
                budget={},
                roster_snapshot=roster.to_json(),
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()
    return mission_id


def runner_with(db, bus, saver, model, monkeypatch):
    import agentd.agents.runner as runner_mod
    from agentd.providers.base import Capabilities

    monkeypatch.setattr(runner_mod.registry, "build_from_profile", lambda _p: model)
    monkeypatch.setattr(runner_mod.registry, "capabilities_for", lambda _p: Capabilities())
    return MissionRunner(db, bus, checkpointer=saver)


async def start_and_pause(runner, db, mission_id, roster, monkeypatch):
    """Run until the approval gate stops it."""
    from agentd.core.budget import BudgetLimits

    limits = BudgetLimits(
        max_llm_calls=50, max_supersteps=50, max_tokens=10**6, timeout_sec=300
    )
    # Provider lookup goes through the snapshot; there is no profile row here.
    monkeypatch.setattr(
        runner, "_run_team", runner._run_team
    )  # keep the real implementation
    await runner._run_team(
        mission_id, roster, "Investigate.", limits, require_approval=True
    )
    await asyncio.sleep(0)


# ---- the hard criterion -------------------------------------------------


async def test_an_approval_survives_the_process_that_asked(db, bus, saver, monkeypatch):
    """**The M6 criterion.** Close the app, reopen it, answer the question."""
    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)

    first = runner_with(db, bus, saver, TeamModel(), monkeypatch)
    await start_and_pause(first, db, mission_id, roster, monkeypatch)

    # It paused rather than finished.
    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()
    assert mission.status == "waiting"
    request_id = mission.pending_request
    assert request_id

    events = await bus.history(mission_id, 0, 10**6)
    asked = [e for e in events if e["draft"]["type"] == "agent.request"]
    assert len(asked) == 1
    assert asked[0]["draft"]["payload"]["kind"] == "approval"
    # The question is on the log before the pause, so a replay shows it even if
    # nobody ever answers.
    assert "Approve this plan" in asked[0]["draft"]["payload"]["question"]

    # --- the app closes. Everything the first runner held is gone. ---
    del first

    second = runner_with(db, bus, saver, TeamModel(), monkeypatch)
    resumed = await second.resolve_request(request_id, APPROVE)
    assert resumed == mission_id
    await second.wait(mission_id)

    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()
    assert mission.status == "ended"
    assert mission.end_reason == "completed"

    events = await bus.history(mission_id, 0, 10**6)
    types = [e["draft"]["type"] for e in events]
    # The answer is on the record between the question and the work it unblocked
    # — without it a replay shows an agent asking and then acting on nothing.
    assert types.index("agent.request") < types.index("agent.request.resolved")
    resolved = next(
        e for e in events if e["draft"]["type"] == "agent.request.resolved"
    )
    assert resolved["draft"]["payload"]["requestId"] == request_id
    assert resolved["draft"]["payload"]["resolvedBy"] == "user"


async def test_a_waiting_mission_is_not_reaped_as_orphaned(db, bus, saver, monkeypatch):
    """The reaper closes missions abandoned by a dead process. A mission paused
    on a person has no task *by design*, and closing it would destroy exactly
    what this milestone promises."""
    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)
    runner = runner_with(db, bus, saver, TeamModel(), monkeypatch)
    await start_and_pause(runner, db, mission_id, roster, monkeypatch)

    assert await MissionRunner(db, bus).reap_orphans() == 0

    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()
    assert mission.status == "waiting"


async def test_a_restarted_frontend_can_find_what_is_waiting(
    db, bus, saver, monkeypatch
):
    """The question was published in an earlier session; a fresh client has no
    way to know about it without asking."""
    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)
    runner = runner_with(db, bus, saver, TeamModel(), monkeypatch)
    await start_and_pause(runner, db, mission_id, roster, monkeypatch)

    pending = await MissionRunner(db, bus).pending_requests()
    assert len(pending) == 1
    assert pending[0]["missionId"] == mission_id
    # The question itself comes back, read off the append-only log.
    assert "Approve this plan" in pending[0]["question"]
    assert pending[0]["kind"] == "approval"
    assert pending[0]["options"] == ["approve", "reject"]


async def test_rejecting_the_plan_ends_the_mission_as_a_decision(
    db, bus, saver, monkeypatch
):
    """Not a failure. The user changed their mind, and the record should not
    describe that as something breaking."""
    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)
    runner = runner_with(db, bus, saver, TeamModel(), monkeypatch)
    await start_and_pause(runner, db, mission_id, roster, monkeypatch)

    request_id = (await runner.pending_requests())[0]["requestId"]
    await runner.resolve_request(request_id, "reject")
    await runner.wait(mission_id)

    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()
    assert mission.end_reason == "cancelled"
    assert "rejected" in (mission.result_summary or "")


async def test_answering_twice_is_refused_rather_than_running_twice(
    db, bus, saver, monkeypatch
):
    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)
    runner = runner_with(db, bus, saver, TeamModel(), monkeypatch)
    await start_and_pause(runner, db, mission_id, roster, monkeypatch)

    request_id = (await runner.pending_requests())[0]["requestId"]
    await runner.resolve_request(request_id, APPROVE)
    await runner.wait(mission_id)

    with pytest.raises(RequestNotFound):
        await runner.resolve_request(request_id, APPROVE)


async def test_no_approval_gate_means_no_pause(db, bus, saver, monkeypatch):
    """Approval is opt-in. Every mission stopping for a click would make the
    feature something users turn off rather than use."""
    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)
    runner = runner_with(db, bus, saver, TeamModel(), monkeypatch)

    from agentd.core.budget import BudgetLimits

    await runner._run_team(
        mission_id,
        roster,
        "Investigate.",
        BudgetLimits(max_llm_calls=50, max_supersteps=50, max_tokens=10**6, timeout_sec=300),
        require_approval=False,
    )
    await runner.wait(mission_id)

    assert await runner.pending_requests() == []
    events = await bus.history(mission_id, 0, 10**6)
    assert not [e for e in events if e["draft"]["type"] == "agent.request"]


# ---- artifacts ----------------------------------------------------------


async def test_a_completed_mission_keeps_its_answer_as_a_file(
    db, bus, saver, monkeypatch, tmp_path
):
    from agentd.core import config

    monkeypatch.setattr(
        config, "get_settings", lambda: config.Settings(data_dir=tmp_path)
    )
    import agentd.artifacts.store as store_mod

    monkeypatch.setattr(store_mod, "get_settings", lambda: config.Settings(data_dir=tmp_path))

    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)
    runner = runner_with(db, bus, saver, TeamModel(), monkeypatch)

    from agentd.core.budget import BudgetLimits

    await runner._run_team(
        mission_id,
        roster,
        "Investigate.",
        BudgetLimits(max_llm_calls=50, max_supersteps=50, max_tokens=10**6, timeout_sec=300),
    )
    await runner.wait(mission_id)

    artifacts = await ArtifactStore(db).for_mission(mission_id)
    assert len(artifacts) == 1
    assert artifacts[0].kind == "doc"
    assert await ArtifactStore(db).read_text(artifacts[0])

    events = await bus.history(mission_id, 0, 10**6)
    created = [e for e in events if e["draft"]["type"] == "artifact.created"]
    assert len(created) == 1
    # The event links to the row, so the viewer can open what the log mentions.
    assert created[0]["draft"]["payload"]["artifactId"] == artifacts[0].id


def test_an_artifact_path_cannot_escape_its_mission(tmp_path, monkeypatch):
    """The viewer reads by path on a process that holds the keychain. An
    absolute path or a `..` chain would turn it into a file browser."""
    from agentd.core import config
    import agentd.artifacts.store as store_mod

    monkeypatch.setattr(store_mod, "get_settings", lambda: config.Settings(data_dir=tmp_path))

    for escape in ["../../secrets.txt", "a/../../../etc/passwd", "..\\..\\keys"]:
        with pytest.raises(ArtifactRejected):
            _safe("m-1", escape)

    # And an ordinary name still resolves.
    assert _safe("m-1", "final-answer.md").name == "final-answer.md"


async def test_two_artifacts_with_the_same_title_do_not_collide(db, tmp_path, monkeypatch):
    from agentd.core import config
    import agentd.artifacts.store as store_mod

    monkeypatch.setattr(store_mod, "get_settings", lambda: config.Settings(data_dir=tmp_path))
    async with db.session() as s:
        s.add(
            Mission(
                id="m-art",
                kind="mission",
                team_id=None,
                goal="g",
                status="ended",
                budget={},
                roster_snapshot=[],
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()

    store = ArtifactStore(db)
    first = await store.write_text(
        mission_id="m-art", agent_id="a1", title="Notes", text="one"
    )
    second = await store.write_text(
        mission_id="m-art", agent_id="a1", title="Notes", text="two"
    )
    assert first.path != second.path
    assert await store.read_text(first) == "one"
    assert await store.read_text(second) == "two"


async def test_resuming_does_not_ask_the_question_a_second_time(
    db, bus, saver, monkeypatch
):
    """Found on a real run, at seq 11.

    LangGraph re-executes the interrupted node from the top on resume, so every
    line above `interrupt()` runs twice. The gate emitted its question again
    with a fresh request id — one nothing was waiting on, so a live client would
    raise a modal whose answer comes back 409, and a replay would show the
    leader asking twice and being answered once.
    """
    roster = roster_of_three()
    mission_id = await seed_mission(db, roster)
    runner = runner_with(db, bus, saver, TeamModel(), monkeypatch)
    await start_and_pause(runner, db, mission_id, roster, monkeypatch)

    request_id = (await runner.pending_requests())[0]["requestId"]
    await runner.resolve_request(request_id, APPROVE)
    await runner.wait(mission_id)

    events = await bus.history(mission_id, 0, 10**6)
    asked = [e for e in events if e["draft"]["type"] == "agent.request"]
    assert len(asked) == 1, "the question was published again on resume"
    assert asked[0]["draft"]["payload"]["requestId"] == request_id

    # And the pause is over: nobody is left on `waiting` at the end of a run
    # that completed.
    statuses = [
        e["draft"]["payload"]["status"]
        for e in events
        if e["draft"]["type"] == "agent.status"
    ]
    assert statuses[-1] != "waiting"
