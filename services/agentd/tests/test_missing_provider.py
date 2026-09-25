"""Deleting a model endpoint must not crash the runs that used it.

A snapshot is frozen on purpose: `provider_id` is never re-read from the agents
table, because who did the earlier rounds must not change retroactively (§5.1).
The honest consequence is that deleting an endpoint makes every older run
impossible to continue — and that was discovered the worst way.

On a real install the DeepSeek profile had been deleted and re-created, so four
saved runs pointed at `prov-279ac324...` which was no longer there. Pressing
continue reopened the row, published the plan message, and died with

    error [no_provider] Pepper has no usable provider profile

over a run recorded `crashed` with `0 tokens`, after a paragraph had been typed.
An internal sentence, at the worst possible moment, for a situation the app
could have seen coming before it started.
"""

from __future__ import annotations

import pytest
from datetime import UTC, datetime

from sqlalchemy import select

from agentd.agents.runner import MissionRejected, MissionRunner
from agentd.core.events import EventBus
from agentd.db.models import Mission, ProviderProfile
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

pytestmark = pytest.mark.anyio


def member(name: str, provider_id: str | None, seat: int = 0) -> SnapshotMember:
    return SnapshotMember(
        agent_id=f"a-{seat}",
        name=name,
        title="",
        role="",
        seat_index=seat,
        role_in_team="leader" if seat == 0 else "member",
        system_prompt="s",
        provider_id=provider_id,
        model="m",
        sampling=None,
        tools=[],
        autonomy="ask_dangerous",
        avatar_config={},
    )


def runner(db) -> MissionRunner:
    return MissionRunner(db=db, bus=EventBus(db=db))


async def test_a_deleted_endpoint_is_refused_not_crashed(db):
    roster = RosterSnapshot(
        [member("Pepper", "prov-gone"), member("Juniper", "prov-gone", 1)],
        workspace_root="C:/ws",
    )
    with pytest.raises(MissionRejected) as caught:
        await runner(db)._refuse_missing_providers(roster)

    problems = caught.value.problems
    assert len(problems) == 1, "one sentence, not one per member"
    said = problems[0]
    # Both names, so it is clear this is the whole team and not one agent.
    assert "Pepper" in said and "Juniper" in said
    # And what to do about it, because "no usable provider profile" is not
    # something a person can act on.
    assert "start a new run" in said


async def test_an_endpoint_that_still_exists_passes(db):
    async with db.session() as s:
        s.add(
            ProviderProfile(
                id="prov-here",
                name="DeepSeek",
                kind="openai_compatible",
                base_url="https://api.example.com/v1",
                model="m",
                created_at=datetime.now(UTC),
            )
        )
        await s.commit()

    roster = RosterSnapshot([member("Pepper", "prov-here")], workspace_root="C:/ws")
    # No exception: the check must not refuse a run that can actually go.
    await runner(db)._refuse_missing_providers(roster)


async def test_a_member_with_no_endpoint_at_all_is_also_refused(db):
    # `provider_id` is nullable, and an agent saved without one cannot think
    # either. Same refusal rather than a different crash further in.
    roster = RosterSnapshot([member("Pepper", None)], workspace_root="C:/ws")
    with pytest.raises(MissionRejected):
        await runner(db)._refuse_missing_providers(roster)


async def test_nothing_is_reopened_when_the_endpoint_is_gone(db):
    """The refusal has to land before the row goes back to `running`.

    A mission left saying `running` with nothing driving it is the timeline
    lying about the present, which is the whole reason `reap_orphans` exists.
    """
    roster = RosterSnapshot([member("Pepper", "prov-gone")], workspace_root="C:/ws")
    async with db.session() as s:
        s.add(
            Mission(
                id="m1",
                kind="mission",
                title="Old run",
                goal="do the thing",
                status="ended",
                end_reason="completed",
                roster_snapshot=roster.to_json(),
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()

    with pytest.raises(MissionRejected):
        await runner(db).continue_mission("m1", "carry on")

    async with db.session() as s:
        row = (
            await s.execute(select(Mission).where(Mission.id == "m1"))
        ).scalar_one()
        assert row.status == "ended", "the row was reopened before the refusal"
        assert row.end_reason == "completed", "the old ending was overwritten"
        assert row.goal == "do the thing", "the new message replaced the old goal"
