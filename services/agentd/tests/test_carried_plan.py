"""A paused round carries its plan instead of asking for a new one.

Reported as "it keeps adding work and never finishes; the later rounds hit
the limit very fast and waste a lot." Measured on that run (five rounds,
7,480,984 tokens, every round `budget_exceeded`):

    rd planned done  tokens
     1       8    4  1,462,996
     2       5    3  1,532,446
     3       9    5  1,452,993
     4       5    1  1,548,518
     5       5    1  1,484,031

Rounds 2-5 were all the retry button, whose message says "Do them, and only
them" — and the leader wrote a fresh five-task plan every time anyway.
Rounds 4 and 5 are the same five items reworded. `docs/QA_REPORT.md` was
planned in four separate rounds and does not exist: the verification tail is
last in every plan, so it was cut every time.

Nothing was wrong with the plan. There was never room to reach the end of it.
"""

from __future__ import annotations

import json

import pytest

from agentd.agents.runner import MissionRunner

pytestmark = pytest.mark.anyio


def progress(task_id, label, state, *, seat=None, instruction="", depends=None):
    payload = {
        "taskId": task_id,
        "label": label,
        "state": state,
        "done": 0,
        "total": 3,
    }
    if state == "pending":
        payload["instruction"] = instruction
        if seat is not None:
            payload["assigneeSeat"] = seat
        if depends is not None:
            payload["dependsOn"] = depends
    return ("mission.progress", payload)


async def carried(db, bus, mission_id, events):
    """Put `events` on a mission's log and ask what a resume would carry.

    `mission_id` is the conftest fixture: `mission_events` has a real foreign
    key and `PRAGMA foreign_keys` is ON, so the parent row has to exist first.
    """
    runner = MissionRunner(db, bus)
    for kind, payload in events:
        await bus.publish(mission_id, {"type": kind, "payload": payload})
    return await runner.carried_plan(mission_id)


async def test_it_carries_what_the_round_did_not_finish(db, bus, mission_id):
    plan = await carried(
        db,
        bus,
        mission_id,
        [
            progress("t1", "Write the spec", "pending", seat=1, instruction="Do t1"),
            progress("t2", "Build it", "pending", seat=2, instruction="Do t2"),
            progress("t3", "QA it", "pending", seat=3, instruction="Do t3"),
            progress("t1", "Write the spec", "done"),
            progress("t2", "Build it", "stopped"),
        ],
    )
    # t1 is done and gone. t2 ran and did not deliver, t3 never started, and
    # both are still owed — in the plan's own order.
    assert [t["id"] for t in plan] == ["t2", "t3"]
    assert [t["assignee_seat"] for t in plan] == [2, 3]
    assert plan[0]["instruction"] == "Do t2"
    assert plan[0]["title"] == "Build it"


async def test_only_the_last_round_is_carried(db, bus, mission_id):
    """A round boundary resets, and the first event of the next one opens it.

    Two earlier versions of this got the boundary wrong in opposite
    directions, and each was caught by running it over a real log rather than
    a fixture. Clearing at `mission.ended` returned nothing at all — the last
    thing on a finished run's log *is* an ending. Not clearing returned five
    rounds as one plan with the same task repeated.
    """
    plan = await carried(
        db,
        bus,
        mission_id,
        [
            progress("a1", "Old round task", "pending", seat=1, instruction="old"),
            progress("a1", "Old round task", "stopped"),
            ("mission.ended", {"reason": "budget_exceeded", "summary": ""}),
            progress("b1", "New round task", "pending", seat=2, instruction="new"),
            progress("b2", "Also new", "pending", seat=3, instruction="new2"),
            progress("b1", "New round task", "done"),
        ],
    )
    assert [t["id"] for t in plan] == ["b2"], "the old round leaked through"


async def test_a_finished_plan_carries_nothing(db, bus, mission_id):
    plan = await carried(
        db,
        bus,
        mission_id,
        [
            progress("t1", "Only task", "pending", seat=1, instruction="go"),
            progress("t1", "Only task", "done"),
        ],
    )
    assert plan == []


async def test_absent_and_empty_dependencies_stay_different(db, bus, mission_id):
    """`depends_on` has three states and a resume must not flatten them.

    Absent means "after the one before it"; [] means "may start immediately".
    Turning an absent one into [] would make a sequential plan suddenly run
    everything at once on the round somebody resumed it.
    """
    plan = await carried(
        db,
        bus,
        mission_id,
        [
            progress("t1", "First", "pending", seat=1, depends=[]),
            progress("t2", "Second", "pending", seat=2),
            progress("t3", "Third", "pending", seat=3, depends=["t1"]),
        ],
    )
    by_id = {t["id"]: t for t in plan}
    assert by_id["t1"]["depends_on"] == []
    assert "depends_on" not in by_id["t2"]
    assert by_id["t3"]["depends_on"] == ["t1"]


async def test_a_round_recorded_before_the_seat_existed_is_refused(db, bus, mission_id):
    """Refuse the whole plan rather than carry a broken one.

    Every task would default to seat 0 — the leader — who is never assigned a
    task when the team has workers, so the resumed round would do nothing at
    all. The caller re-plans as it always did. Measured against the real log
    of the reported run, whose `pending` events predate the field.
    """
    plan = await carried(
        db,
        bus,
        mission_id,
        [
            # No `assigneeSeat`: exactly the shape of a pre-v0.3.5 event.
            ("mission.progress", {"taskId": "t1", "label": "Old", "state": "pending",
                                  "done": 0, "total": 1, "instruction": "go"}),
        ],
    )
    assert plan == []
