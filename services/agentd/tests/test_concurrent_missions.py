"""One team, two missions at once (§5.1, §1.1).

Nothing stops it — `start_mission` has no team-level guard, and per-mission
state is keyed by mission id throughout: the task, the finaliser, the mailbox,
the checkpointer thread, the frozen roster, the budget, the event stream.
Verified live: two runs of the same one-agent team answered `alpha` and `beta`
with no event from either appearing on the other's log.

What is *not* per mission is the agent row both runs credit at the end.
`total_missions += 1` read the value and wrote it back with an `await` in
between, which is the shape a lost update comes from.

**It was not reproduced here.** Each session takes its own connection and
SQLite serialises the writes, so the two credits landed in order every way it
was tried. The statement is atomic now anyway: `total_missions` survived the
gamification rollback because it is the one figure on the card that is a fact,
and "probably fine given how the driver happens to schedule" is not the
guarantee that number deserves.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from agentd.db.models import Agent
from agentd.db.session import Database

pytestmark = pytest.mark.anyio


async def make_agent(db: Database, agent_id: str) -> None:
    async with db.session() as s:
        s.add(
            Agent(
                id=agent_id,
                name="Iris",
                title="t",
                role="r",
                backstory="b",
                personality_traits=[],
                system_prompt="s",
                provider_id=None,
                model=None,
                sampling=None,
                tools=[],
                autonomy="ask_dangerous",
                avatar_config={"build": "lithe"},
                total_missions=0,
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
        await s.commit()


async def credit(db: Database, agent_id: str) -> None:
    """What `_credit_missions` does, in one statement rather than two."""
    from sqlalchemy import update

    async with db.session() as s:
        await s.execute(
            update(Agent)
            .where(Agent.id.in_([agent_id]))
            .values(total_missions=Agent.total_missions + 1)
        )
        await s.commit()


async def total(db: Database, agent_id: str) -> int:
    async with db.session() as s:
        return (
            await s.execute(select(Agent).where(Agent.id == agent_id))
        ).scalar_one().total_missions


async def test_two_runs_finishing_together_are_both_counted(db: Database):
    await make_agent(db, "a-1")
    await asyncio.gather(credit(db, "a-1"), credit(db, "a-1"))
    assert await total(db, "a-1") == 2


async def test_many_at_once_are_all_counted(db: Database):
    await make_agent(db, "a-3")
    await asyncio.gather(*(credit(db, "a-3") for _ in range(8)))
    assert await total(db, "a-3") == 8
