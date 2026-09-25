"""What a finished run cost, counted once.

The screen where a ceiling is chosen knew nothing about what runs on this
machine actually cost. There is no honest way to *forecast* a run (§1.1), so
what it shows is the record — and the record has to be counted the way the
guard counts, or the figure beside a limit is measuring something else. That
rule has been needed four times in this project.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agentd.core.budget import TOKEN_FIELDS, tokens_in
from agentd.core.spend import spend_by_mission
from agentd.db.models import Mission, MissionEvent
from agentd.db.session import Database

pytestmark = pytest.mark.anyio


def test_a_cache_read_counts_like_any_other_token():
    # 79% of a long run is cacheReadTokens. A count that left them out sat at a
    # quarter full on a run the guard had just stopped for being over.
    assert set(TOKEN_FIELDS) == {
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
    }
    assert tokens_in({f: 10 for f in TOKEN_FIELDS}) == 40


def test_nothing_is_nothing_rather_than_an_error():
    assert tokens_in(None) == 0
    assert tokens_in({}) == 0
    assert tokens_in({"inputTokens": None}) == 0


def test_a_boolean_is_not_a_count():
    # `isinstance(True, int)` is True in Python, and a usage block is model
    # output that reached us over a wire. This project has already had to
    # refuse a budget of `True`, which would have been a ceiling of one.
    assert tokens_in({"inputTokens": True, "outputTokens": 5}) == 5


def test_a_string_is_not_a_count():
    assert tokens_in({"inputTokens": "many", "outputTokens": 5}) == 5


async def _run(db: Database, mission_id: str, *usages: dict | None) -> None:
    async with db.session() as s:
        s.add(
            Mission(
                id=mission_id,
                kind="mission",
                goal="g",
                status="ended",
                started_at=datetime.now(UTC),
            )
        )
        for seq, usage in enumerate(usages, 1):
            s.add(
                MissionEvent(
                    id=f"{mission_id}-{seq}",
                    mission_id=mission_id,
                    seq=seq,
                    v=1,
                    # `agent.usage` exists precisely because a round that only
                    # called tools publishes no message — its cost would
                    # otherwise be invisible, which it was.
                    type="agent.usage" if seq % 2 else "agent.message",
                    ts=datetime.now(UTC),
                    payload={"usage": usage} if usage else {},
                )
            )
        await s.commit()


async def test_spend_adds_up_every_usage_block_on_the_log(db: Database):
    await _run(
        db,
        "m-1",
        {"inputTokens": 100, "outputTokens": 20},
        {"cacheReadTokens": 900},
        None,
    )
    async with db.session() as s:
        assert await spend_by_mission(s, ["m-1"]) == {"m-1": 1020}


async def test_a_mission_with_nothing_on_its_log_is_zero_not_missing(db: Database):
    await _run(db, "m-2")
    async with db.session() as s:
        # A key that is absent and a run that spent nothing are different
        # things to the caller drawing the list, so every id asked for comes
        # back.
        assert await spend_by_mission(s, ["m-2", "never-existed"]) == {
            "m-2": 0,
            "never-existed": 0,
        }


async def test_runs_do_not_bleed_into_each_other(db: Database):
    await _run(db, "m-3", {"inputTokens": 7})
    await _run(db, "m-4", {"inputTokens": 11})
    async with db.session() as s:
        assert await spend_by_mission(s, ["m-3", "m-4"]) == {"m-3": 7, "m-4": 11}


async def test_asking_for_nothing_queries_nothing(db: Database):
    async with db.session() as s:
        assert await spend_by_mission(s, []) == {}
