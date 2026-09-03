"""What a team's last few runs cost, beside the box where the limit is typed.

The point of this endpoint is what it is *not*: a forecast. There is no honest
way to estimate a run before it happens (§1.1), and no provider will say. What
there is, is the record — and the record is what was missing from the one
screen where a ceiling gets chosen. The same team spent 1,262,610 tokens on one
job and 23,538 on another.

So the assertion that matters is the arithmetic: the number shown beside a
limit has to count what the limit counts. `BudgetTracker.record_call` adds
input, output, cache read *and* cache write, and a run's cache reads dominate
it. Counting the first two would draw a meter at a quarter of the truth, which
this app has already shipped once.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from starlette.testclient import TestClient

from agentd.core import auth
from agentd.core.config import Settings
from agentd.db.migrate import upgrade_to_head
from agentd.db.models import Mission, MissionEvent, Team
from agentd.db.session import Database
from agentd.main import create_app

TOKEN = "history-token"
HEAD = {"X-Agent-Studio-Token": TOKEN}


@pytest.fixture
def env(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'hist.db').as_posix()}"
    upgrade_to_head(url)
    database = Database(url)
    auth.set_token(TOKEN)
    with TestClient(create_app(settings=Settings(data_dir=tmp_path), db=database)) as c:
        yield c, database
    auth._reset_for_tests()


async def _seed(db: Database) -> None:
    started = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
    async with db.session() as s:
        s.add(
            Team(
                id="t1",
                name="Web dev",
                description="",
                emblem_config={},
                scene_layout_id="open_desks",
                default_budget={},
                created_at=started,
                updated_at=started,
            )
        )
        s.add(
            Team(
                id="t2",
                name="Other",
                description="",
                emblem_config={},
                scene_layout_id="open_desks",
                default_budget={},
                created_at=started,
                updated_at=started,
            )
        )
        for index, (mid, team, reason, limit, done, total) in enumerate(
            [
                ("m1", "t1", "completed", None, 4, 4),
                ("m2", "t1", "budget_exceeded", "tokens", 1, 4),
                ("m3", "t2", "completed", None, 2, 2),
            ]
        ):
            s.add(
                Mission(
                    id=mid,
                    kind="mission",
                    team_id=team,
                    title=f"Run {mid}",
                    goal="g",
                    status="ended",
                    budget={},
                    roster_snapshot=[],
                    started_at=started + timedelta(hours=index),
                    ended_at=started + timedelta(hours=index, minutes=5),
                    end_reason=reason,
                    end_limit=limit,
                    tasks_done=done,
                    tasks_total=total,
                )
            )
        # m1's spend, split across the two events that can carry usage: a round
        # that spoke, and a round that only called tools and so publishes
        # `agent.usage` with no message at all.
        s.add(
            MissionEvent(
                id="e1",
                mission_id="m1",
                seq=1,
                ts=started,
                v=1,
                type="agent.message",
                payload={
                    "usage": {
                        "inputTokens": 100,
                        "outputTokens": 20,
                        "cacheReadTokens": 4000,
                        "cacheWriteTokens": 300,
                    }
                },
            )
        )
        s.add(
            MissionEvent(
                id="e2",
                mission_id="m1",
                seq=2,
                ts=started,
                v=1,
                type="agent.usage",
                payload={"usage": {"inputTokens": 50, "outputTokens": 5}},
            )
        )
        # Not a usage-bearing type, and it carries a number that must not be
        # swept up by a looser filter.
        s.add(
            MissionEvent(
                id="e3",
                mission_id="m1",
                seq=3,
                ts=started,
                v=1,
                type="agent.tool.end",
                payload={"usage": {"inputTokens": 999_999}},
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_the_total_counts_what_the_budget_counts(env):
    client, db = env
    await _seed(db)
    runs = client.get("/teams/t1/history", headers=HEAD).json()["runs"]
    m1 = next(r for r in runs if r["id"] == "m1")
    # 100 + 20 + 4000 + 300, then 50 + 5. Cache reads are 87% of it, which is
    # exactly why leaving them out drew a meter at a quarter of the truth.
    assert m1["tokens"] == 4475


@pytest.mark.asyncio
async def test_it_shows_only_this_team_newest_first(env):
    client, db = env
    await _seed(db)
    runs = client.get("/teams/t1/history", headers=HEAD).json()["runs"]
    assert [r["id"] for r in runs] == ["m2", "m1"]


@pytest.mark.asyncio
async def test_the_ending_and_which_limit_travel_with_it(env):
    client, db = env
    await _seed(db)
    runs = client.get("/teams/t1/history", headers=HEAD).json()["runs"]
    m2 = next(r for r in runs if r["id"] == "m2")
    # "Out of budget" is one phrase for four different problems, and the label
    # can only name the right one if the kind comes with the reason.
    assert (m2["endReason"], m2["endLimit"]) == ("budget_exceeded", "tokens")
    assert (m2["tasksDone"], m2["tasksTotal"]) == (1, 4)


@pytest.mark.asyncio
async def test_a_run_that_spent_nothing_reports_zero(env):
    """Zero is a real answer — a run reaped as `crashed` before it paid for
    anything — and it is not the same as a run we could not measure."""
    client, db = env
    await _seed(db)
    runs = client.get("/teams/t1/history", headers=HEAD).json()["runs"]
    assert next(r for r in runs if r["id"] == "m2")["tokens"] == 0


@pytest.mark.asyncio
async def test_a_team_with_no_finished_runs_is_an_empty_list(env):
    client, db = env
    await _seed(db)
    assert client.get("/teams/unknown/history", headers=HEAD).json()["runs"] == []
