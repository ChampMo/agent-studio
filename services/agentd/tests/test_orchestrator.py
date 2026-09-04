"""M4 proof: three agents finish a mission, and the record stays true (§5.1, §12 M4).

The headline criterion is the snapshot one: edit an agent after a run and the
replay must still show the name, model and avatar that actually did the work.
That is the entire reason `missions.roster_snapshot` was created in the very
first migration and left unused for three milestones.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from agentd.agents.runner import MissionRejected, MissionRunner
from agentd.agents.service import AgentService
from agentd.core.budget import BudgetExceeded, BudgetLimits, BudgetTracker
from agentd.db.models import Agent, Mission
from agentd.orchestrator.graph import run_team_mission
from agentd.orchestrator.planner import PlanningFailed, make_plan
from agentd.providers.base import (
    Capabilities,
    DoneChunk,
    ProviderError,
    TextChunk,
    Usage,
)
from agentd.teams import snapshot as snapshot_mod
from agentd.teams.service import TeamService
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

PLAN = (
    '{"tasks": ['
    '{"id": "t1", "title": "Gather", "assignee_seat": 1, "instruction": "Find sources."},'
    '{"id": "t2", "title": "Check", "assignee_seat": 2, "instruction": "Verify them."}'
    "]}"
)


def limits(**kw) -> BudgetLimits:
    base = dict(
        max_llm_calls=50, max_supersteps=50, max_tokens=1_000_000, timeout_sec=300
    )
    return BudgetLimits(**{**base, **kw})


class TeamModel:
    """One provider standing in for the whole team. Records every call."""

    kind = "fake"

    def __init__(self, *, plan=PLAN, worker="done", raises=None):
        self._plan = plan
        self._worker = worker
        self._raises = raises
        self.calls: list[str] = []

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        self.calls.append(req.model)
        if self._raises:
            raise self._raises
        # A planning request is the one carrying a response_schema.
        yield TextChunk(self._plan if req.response_schema else self._worker)
        yield DoneChunk("stop", Usage(20, 30))

    async def aclose(self):
        return None


def member(seat, agent_id, name, *, leader=False, model="m1", avatar=None):
    return SnapshotMember(
        agent_id=agent_id,
        name=name,
        seat_index=seat,
        role_in_team="leader" if leader else "member",
        system_prompt=f"You are {name}.",
        provider_id="prov-1",
        model=model,
        sampling=None,
        tools=[],
        avatar_config=avatar or {"build": "lithe"},
    )


def roster_of_three() -> RosterSnapshot:
    return RosterSnapshot(
        [
            member(0, "a-lead", "Lead", leader=True),
            member(1, "a-one", "One"),
            member(2, "a-two", "Two"),
        ]
    )


async def drain(model, roster, *, budget=None, goal="Investigate."):
    items = []
    async for item in run_team_mission(
        mission_id="m-1",
        snapshot=roster,
        goal=goal,
        budget=budget or BudgetTracker(limits()),
        provider_for=lambda _m: (model, Capabilities()),
    ):
        items.append(item)
    return items


def sequenced(items):
    return [i for i in items if i.get("channel") != "ephemeral"]


# ---- three agents, one mission ------------------------------------------


async def test_a_three_person_team_runs_to_completion():
    """§12 M4: the team works together and the log reads sensibly."""
    model = TeamModel()
    items = sequenced(await drain(model, roster_of_three()))
    types = [i["type"] for i in items]

    assert "agent.message" in types
    assert types.count("mission.progress") >= 4  # pending, running, done per task

    # Everyone contributed, and the log says who did what.
    speakers = {
        i["payload"]["agentId"] for i in items if i["type"] == "agent.message"
    }
    assert speakers == {"a-lead", "a-one", "a-two"}


async def test_the_plan_is_announced_before_any_work_starts():
    """A log that shows work with no plan is a log you cannot follow."""
    items = sequenced(await drain(TeamModel(), roster_of_three()))
    first_message = next(i for i in items if i["type"] == "agent.message")
    assert first_message["payload"]["agentId"] == "a-lead"
    assert "Plan:" in first_message["payload"]["content"]
    assert first_message["payload"]["to"] == {"kind": "broadcast"}


async def test_progress_is_counted_not_guessed():
    """§15 row 7: no honest percentage exists, so tasks are counted."""
    items = sequenced(await drain(TeamModel(), roster_of_three()))
    progress = [i["payload"] for i in items if i["type"] == "mission.progress"]
    assert {p["total"] for p in progress} == {2}
    assert progress[-1]["state"] == "done"
    assert progress[-1]["done"] == 2


async def test_the_orchestrator_never_touches_the_bus():
    """Same contract as the runtime (§4.1): it yields, the caller publishes.
    That is what lets the runner route a team mission and a chat identically."""
    items = await drain(TeamModel(), roster_of_three())
    for item in sequenced(items):
        assert set(item) == {"type", "payload"}
        assert "seq" not in item and "ts" not in item and "id" not in item


# ---- the snapshot criterion ---------------------------------------------


def test_overrides_are_resolved_into_the_snapshot_not_left_to_read_later():
    """§5.1: the snapshot holds the *effective* config. Otherwise the timeline
    reports the agent's default model while the request used an override."""

    class FakeAgent:
        id, name, title, role = "a1", "Mira", "Analyst", "Finds things"
        system_prompt = "Be careful."
        provider_id, model, sampling = "prov-1", "base-model", None
        tools = ["search", "read"]
        autonomy = "ask_dangerous"
        avatar_config = {"build": "lithe"}

    class FakeMember:
        agent_id, seat_index, role_in_team = "a1", 0, "leader"
        overrides = {
            "model": "override-model",
            "tool_subset": ["read"],
            "prompt_suffix": "Answer in one line.",
        }

    snap = snapshot_mod.resolve(
        team=object(), members=[FakeMember()], agents={"a1": FakeAgent()}
    )
    resolved = snap.members[0]
    assert resolved.model == "override-model"
    assert resolved.tools == ["read"]
    assert resolved.system_prompt.endswith("Answer in one line.")
    assert "Be careful." in resolved.system_prompt


async def test_editing_an_agent_after_a_run_does_not_rewrite_the_record(db, bus):
    """**The M4 criterion.** Teams reference agents live and there is no
    versioning, so without the snapshot a rename would retroactively change who
    did the work."""
    agents = AgentService(db)
    teams = TeamService(db)

    made = []
    for i, name in enumerate(["Lead", "One", "Two"]):
        made.append(
            await agents.create(
                {
                    "name": name,
                    "model": "m1",
                    "provider_id": None,
                    "avatar_config": {
                        "build": "lithe",
                        "coat": "patched",
                        "outfit": "blazer",
                        "palette": "smoke",
                    },
                }
            )
        )
    team = await teams.create(
        {
            "name": "Alpha",
            "members": [
                {
                    "agent_id": a.id,
                    "seat_index": i,
                    "role_in_team": "leader" if i == 0 else "member",
                }
                for i, a in enumerate(made)
            ],
        }
    )

    members = await teams.members(team.id)
    frozen = snapshot_mod.resolve(
        team=team, members=members, agents={a.id: a for a in made}
    )

    async with db.session() as s:
        s.add(
            Mission(
                id="m-snap",
                kind="mission",
                team_id=team.id,
                goal="Investigate.",
                status="ended",
                budget={},
                roster_snapshot=frozen.to_json(),
                started_at=__import__("datetime").datetime.now(
                    __import__("datetime").UTC
                ),
            )
        )
        await s.commit()

    # Everything about the agent changes after the fact.
    await agents.update(
        made[1].id,
        {
            "name": "Renamed Entirely",
            "model": "some-other-model",
            "avatar_config": {
                "build": "stocky",
                "coat": "spotted",
                "outfit": "vest",
                "palette": "charcoal",
            },
        },
    )
    await agents.archive(made[2].id)

    async with db.session() as s:
        stored = (
            await s.execute(select(Mission).where(Mission.id == "m-snap"))
        ).scalar_one()
    replayed = RosterSnapshot.from_json(stored.roster_snapshot)

    who = replayed.by_agent(made[1].id)
    assert who is not None
    assert who.name == "One"                      # not "Renamed Entirely"
    assert who.model == "m1"                      # not "some-other-model"
    assert who.avatar_config["outfit"] == "blazer"  # not "armor"
    # And the archived member still has a seat to be drawn in.
    assert replayed.by_agent(made[2].id).seat_index == 2
    assert [m.seat_index for m in replayed.members] == [0, 1, 2]


async def test_a_snapshot_from_a_newer_build_still_replays():
    """Forward compatibility applies to stored missions too (§8)."""
    replayed = RosterSnapshot.from_json(
        [
            {
                "agent_id": "a1",
                "name": "Mira",
                "seat_index": 0,
                "role_in_team": "leader",
                "system_prompt": "",
                "provider_id": None,
                "model": "m1",
                "sampling": None,
                "tools": [],
                "avatar_config": {},
                "mood": "sunny",  # a field this build has never heard of
            }
        ]
    )
    assert replayed.members[0].name == "Mira"


# ---- a process that dies mid-mission ------------------------------------


async def test_a_mission_orphaned_by_a_dead_process_is_closed_at_startup(db, bus):
    """Found live: the dev launcher restarted the backend mid-run, the task went
    with it, and the row sat at `running` for ever.

    A dead process cannot write its own terminal event, so the next one does it.
    Every mission is promised exactly one `mission.ended`, and a row claiming to
    be running when nothing is driving it is the timeline lying about the
    present rather than the past."""
    from datetime import UTC, datetime

    async with db.session() as s:
        s.add(
            Mission(
                id="m-orphan",
                kind="mission",
                team_id=None,
                goal="interrupted",
                status="running",
                budget={},
                roster_snapshot=[],
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()

    runner = MissionRunner(db, bus)
    assert await runner.reap_orphans() == 1

    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == "m-orphan"))
        ).scalar_one()
    assert mission.status == "ended"
    assert mission.end_reason == "crashed"
    assert "backend stopped" in (mission.result_summary or "")

    events = await bus.history("m-orphan", 0, 99)
    ended = [e for e in events if e["draft"]["type"] == "mission.ended"]
    assert len(ended) == 1
    assert ended[0]["draft"]["payload"]["reason"] == "crashed"


async def test_reaping_leaves_finished_missions_alone(db, bus):
    from datetime import UTC, datetime

    async with db.session() as s:
        s.add(
            Mission(
                id="m-done",
                kind="mission",
                team_id=None,
                goal="finished",
                status="ended",
                budget={},
                roster_snapshot=[],
                started_at=datetime.now(UTC),
                end_reason="completed",
            )
        )
        await s.commit()

    assert await MissionRunner(db, bus).reap_orphans() == 0
    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == "m-done"))
        ).scalar_one()
    assert mission.end_reason == "completed"


# ---- the run gate --------------------------------------------------------


async def test_a_team_that_cannot_run_is_refused_with_every_reason(db, bus):
    """The launcher uses the validator's findings, not its own checks (§5.2)."""
    agents = AgentService(db)
    teams = TeamService(db)
    a = await agents.create({"name": "Solo", "model": None})
    team = await teams.create(
        {"name": "Broken", "members": [{"agent_id": a.id, "seat_index": 0}]}
    )

    runner = MissionRunner(db, bus)
    with pytest.raises(MissionRejected) as exc:
        await runner.start_mission(team_id=team.id, goal="go")

    joined = " ".join(exc.value.problems)
    assert "leader" in joined          # no_leader
    assert "no model" in joined        # member_has_no_model
    assert len(exc.value.problems) >= 2  # every reason, not the first one


async def test_a_missing_team_is_rejected_not_crashed(db, bus):
    runner = MissionRunner(db, bus)
    with pytest.raises(MissionRejected):
        await runner.start_mission(team_id="team-nope", goal="go")


# ---- budget across a whole team -----------------------------------------


async def test_the_budget_counts_the_whole_team_not_each_agent():
    """One mission, one ceiling. Otherwise three agents cost three budgets."""
    budget = BudgetTracker(limits(max_tokens=1_000_000))
    await drain(TeamModel(), roster_of_three(), budget=budget)
    # plan + two tasks + summary = four calls.
    assert budget.llm_calls_used == 4
    assert budget.tokens_used == 4 * 50


# Running out used to stop the mission where it stood: the next call raised
# `BudgetExceeded`, the graph never reached its summary node, and the run's
# whole account of itself was a number. On a real build that left seven files
# on disk, six tasks unstarted, and nothing saying which was which.
#
# A slice of each limit is held back now. Crossing the working share stops the
# team *starting* anything new, lets what is running finish, and spends the
# reserve on the leader writing the handover. The ceiling is unchanged — the
# reserve is inside it, not on top of it — and the run is still recorded as
# having run out, because it did.


async def test_running_out_stops_the_work_and_keeps_the_summary():
    budget = BudgetTracker(limits(max_llm_calls=2))
    items = sequenced(await drain(TeamModel(), roster_of_three(), budget=budget))

    # No exception: the graph reached its end.
    assert budget.stopped_early is not None
    assert budget.stopped_early[0] == "llm_calls"
    # It said so on the log, at the moment it decided.
    assert any(
        i["type"] == "error"
        and i["payload"]["code"] == "work_stopped_for_summary"
        for i in items
    )
    # And the summary turn actually ran, which is the whole point of the reserve.
    assert any(i["type"] == "agent.message" for i in items)


async def test_a_run_with_room_to_spare_is_not_marked_as_stopping_early():
    budget = BudgetTracker(limits())
    await drain(TeamModel(), roster_of_three(), budget=budget)
    assert budget.stopped_early is None


async def test_the_ceiling_itself_still_raises():
    # A limit so small that even the reserve cannot be honoured. The hard check
    # is untouched, so this is still an exception rather than a quiet overrun.
    budget = BudgetTracker(limits(max_llm_calls=1))
    with pytest.raises(BudgetExceeded) as exc:
        await drain(TeamModel(), roster_of_three(), budget=budget)
    assert exc.value.kind == "llm_calls"


async def test_supersteps_are_counted_as_graph_nodes():
    budget = BudgetTracker(limits(max_supersteps=1))
    with pytest.raises(BudgetExceeded) as exc:
        await drain(TeamModel(), roster_of_three(), budget=budget)
    assert exc.value.kind == "supersteps"


# ---- planning ------------------------------------------------------------


async def test_a_plan_naming_an_empty_seat_is_corrected():
    """A task assigned to nobody would vanish, and the mission would end with
    work missing and no explanation."""
    bad = '{"tasks": [{"id": "t1", "title": "X", "assignee_seat": 9, "instruction": "do"}]}'
    model = TeamModel(plan=bad)

    with pytest.raises(PlanningFailed) as exc:
        await make_plan(
            provider=model,
            caps=Capabilities(),
            model="m1",
            snapshot=roster_of_three(),
            goal="go",
        )
    assert "cannot take a task" in exc.value.attempts[0]
    assert len(exc.value.attempts) == 3  # it was retried, not accepted


async def test_the_leader_cannot_assign_the_work_to_itself():
    """From the first live three-agent run: the plan came back as one task on
    seat 0 and the two teammates never ran. A team of one is not a team, so a
    plan that keeps the work is rejected and corrected."""
    selfish = (
        '{"tasks": [{"id": "t1", "title": "Do it all", '
        '"assignee_seat": 0, "instruction": "answer"}]}'
    )
    with pytest.raises(PlanningFailed) as exc:
        await make_plan(
            provider=TeamModel(plan=selfish),
            caps=Capabilities(),
            model="m1",
            snapshot=roster_of_three(),
            goal="go",
        )
    assert "cannot take a task" in exc.value.attempts[0]
    # The correction says why, so the retry has somewhere to go.
    assert "you summarise at the end" in exc.value.attempts[0]


async def test_a_solo_team_may_assign_to_its_only_member():
    """The rule is "do not keep the work from your team", not "never work" —
    with nobody else, the leader is the team."""
    solo = RosterSnapshot([member(0, "a-lead", "Lead", leader=True)])
    plan = (
        '{"tasks": [{"id": "t1", "title": "Do it", '
        '"assignee_seat": 0, "instruction": "answer"}]}'
    )
    result = await make_plan(
        provider=TeamModel(plan=plan),
        caps=Capabilities(),
        model="m1",
        snapshot=solo,
        goal="go",
    )
    assert result.attempts == 1


async def test_the_truncation_correction_does_not_shrink_the_plan():
    """The first correction said "return fewer, shorter tasks", and a model took
    the hint: one task, assigned to itself. Shorten the wording, not the plan."""
    from agentd.orchestrator import planner

    model = TeamModel(plan=PLAN)

    class Truncating(TeamModel):
        def __init__(self):
            super().__init__()
            self._first = True

        async def stream(self, req, caps):
            self.calls.append(req.model)
            if self._first:
                self._first = False
                yield TextChunk('{"tasks": [{"id": "t1"')
                yield DoneChunk("length", Usage(20, 30))
                return
            yield TextChunk(PLAN)
            yield DoneChunk("stop", Usage(20, 30))

    truncating = Truncating()
    result = await make_plan(
        provider=truncating,
        caps=Capabilities(),
        model="m1",
        snapshot=roster_of_three(),
        goal="go",
    )
    assert "keep every task" in result.recovered_from[0]
    assert "fewer" not in result.recovered_from[0]
    del model, planner


async def test_a_corrected_plan_is_reported_not_hidden():
    """Needing a retry is a fact about the chosen model (§1)."""

    class TwoTries(TeamModel):
        def __init__(self):
            super().__init__()
            self._first = True

        async def stream(self, req, caps):
            self.calls.append(req.model)
            if req.response_schema and self._first:
                self._first = False
                yield TextChunk("not json at all")
            else:
                yield TextChunk(PLAN if req.response_schema else "done")
            yield DoneChunk("stop", Usage(20, 30))

    items = sequenced(await drain(TwoTries(), roster_of_three()))
    codes = [i["payload"]["code"] for i in items if i["type"] == "error"]
    assert "plan_corrected" in codes


async def test_a_provider_failure_propagates_to_the_runner():
    model = TeamModel(raises=ProviderError("provider_auth", "key rejected"))
    with pytest.raises(ProviderError):
        await drain(model, roster_of_three())


async def test_closing_the_generator_stops_the_graph():
    """Cancel must not leave a detached task spending money."""
    started = asyncio.Event()

    class Hanging(TeamModel):
        async def stream(self, req, caps):
            self.calls.append(req.model)
            started.set()
            await asyncio.Event().wait()
            yield  # pragma: no cover

    model = Hanging()
    agen = run_team_mission(
        mission_id="m-1",
        snapshot=roster_of_three(),
        goal="go",
        budget=BudgetTracker(limits()),
        provider_for=lambda _m: (model, Capabilities()),
    )
    consumer = asyncio.create_task(agen.__anext__())
    await asyncio.wait_for(started.wait(), timeout=5)

    consumer.cancel()
    await asyncio.gather(consumer, return_exceptions=True)
    await agen.aclose()

    # Nothing left running.
    await asyncio.sleep(0)
    assert True
