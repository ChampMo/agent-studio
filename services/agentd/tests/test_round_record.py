"""What a round that failed to plan is allowed to say about the round before it.

All three of these come off one real run. A six-task round was stopped by the
token limit at `4 of 6 tasks done`; the retry the app offered died in planning;
and afterwards the row read 0 of 0, the ending named no limit, and the leader's
3,837-character handover had been cut at 2,000 — mid-word, at *"All of Test
Plan sections 2+**, an"*.

The handover is the sharp one. That string is the ending on the timeline, the
text of `final-answer.md`, and — through `earlier_rounds` — the only thing the
next round's planner is told about what happened. Losing half of it silently is
the app being untrue about the record (§1); saying it was shortened is not.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from agentd.agents.runner import SUMMARY_CHARS, MissionRunner, shorten
from agentd.api.chat import ROUND_MESSAGE_CHARS, ForkIn, MissionIn, NoteIn
from datetime import UTC, datetime

from agentd.db.models import Mission
from agentd.db.session import Database
from agentd.orchestrator.planner import MAX_INSTRUCTION_CHARS, MAX_TASKS

pytestmark = pytest.mark.anyio

#: What the leader actually wrote on the run this was found on.
REAL_HANDOVER_CHARS = 3837


def test_a_real_handover_survives_whole():
    handover = ("word " * (REAL_HANDOVER_CHARS // 5 + 1))[:REAL_HANDOVER_CHARS]
    assert len(handover) >= REAL_HANDOVER_CHARS
    assert shorten(handover) == handover


def test_a_longer_one_is_cut_at_a_word_and_says_that_it_was():
    text = "alpha bravo charlie delta " * 400
    out = shorten(text)

    assert len(out) <= SUMMARY_CHARS
    assert out.startswith("alpha bravo charlie")
    assert "shortened" in out, "a record that stops mid-word reads as a crash"
    # The give-away from the real run: the cut landed inside "and".
    body = out.split(" … ")[0]
    assert text.startswith(body), "what is kept must be what was written"
    assert not body.endswith(("alph", "brav", "charli", "delt"))


def test_one_enormous_word_is_still_cut():
    out = shorten("x" * (SUMMARY_CHARS * 2))
    assert len(out) <= SUMMARY_CHARS
    assert "shortened" in out


async def test_a_round_that_planned_nothing_leaves_the_counts_alone(db: Database):
    async with db.session() as s:
        s.add(
            Mission(
                id="m-1",
                kind="mission",
                title="PARADOX.ART",
                goal="build it",
                status="ended",
                started_at=datetime.now(UTC),
                tasks_done=4,
                tasks_total=6,
            )
        )
        await s.commit()

    runner = MissionRunner.__new__(MissionRunner)
    runner._db = db

    # The retry died in planning, so no `mission.progress` was ever published.
    await runner._save_task_counts("m-1", {})

    async with db.session() as s:
        row = (
            await s.execute(select(Mission).where(Mission.id == "m-1"))
        ).scalar_one()
        assert (row.tasks_done, row.tasks_total) == (4, 6), (
            "0 of 0 is not a reading of the plan, it is the erasure of one — "
            "and it took the sidebar's shortfall badge with it"
        )


async def test_a_round_that_did_plan_still_records_what_it_reached(db: Database):
    async with db.session() as s:
        s.add(
            Mission(
                id="m-2",
                kind="mission",
                goal="g",
                status="ended",
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()

    runner = MissionRunner.__new__(MissionRunner)
    runner._db = db
    await runner._save_task_counts(
        "m-2", {"t1": ("done", "One"), "t2": ("failed", "Two")}
    )

    async with db.session() as s:
        row = (
            await s.execute(select(Mission).where(Mission.id == "m-2"))
        ).scalar_one()
        assert (row.tasks_done, row.tasks_total) == (1, 2)


def test_every_way_of_starting_a_round_takes_the_same_length():
    body = "x" * ROUND_MESSAGE_CHARS
    assert MissionIn(content=body).content == body
    assert NoteIn(content=body).content == body
    assert ForkIn(content=body).content == body


def test_a_full_plan_can_be_handed_back_as_a_retry():
    # "Pick up what the last round did not finish" quotes every unfinished
    # task's instruction verbatim. The worst case is a whole plan of them, and
    # it used to meet a 4,000 ceiling: two real tasks made 3,846 characters.
    worst = MAX_TASKS * (MAX_INSTRUCTION_CHARS + 120) + 200
    assert worst <= ROUND_MESSAGE_CHARS
    NoteIn(content="x" * worst)
