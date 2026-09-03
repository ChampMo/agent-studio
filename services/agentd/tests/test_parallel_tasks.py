"""Tasks that do not need each other run at the same time (§7).

Work was strictly sequential: task n+1 started when n finished, whatever the two
had to do with each other. A plan like *research A / research B / write it up*
spent two model calls' worth of waiting in a row for no reason.

The unit of the decision is the plan, because the plan is the only place that
knows. Each task may declare `depends_on`, and the field has **three** states
rather than two:

    absent   -> after the task before it. What every plan did before this
                existed, and what a model that ignores the field still gets.
    []       -> needs nothing; may start immediately.
    ["t1"]   -> waits for t1.

So parallelism never happens by accident. It happens because a leader said two
things are independent, and that claim is on the log where it can be read.
"""

from __future__ import annotations

import asyncio

import pytest

from agentd.orchestrator.graph import MAX_PARALLEL, _plan_text, plan_waves
from agentd.orchestrator.planner import Plan, _check_deps


def task(tid: str, *, seat: int = 1, depends_on=...) -> dict:
    out = {"id": tid, "title": tid, "assignee_seat": seat, "instruction": tid}
    if depends_on is not ...:
        out["depends_on"] = depends_on
    return out


# ---- scheduling ---------------------------------------------------------


def test_a_plan_that_says_nothing_stays_sequential():
    # The whole safety of this feature. A model that never writes the field
    # gets exactly the old behaviour.
    waves = plan_waves([task("t1"), task("t2"), task("t3")])
    assert waves == [[0], [1], [2]]


def test_tasks_that_need_nothing_share_a_wave():
    waves = plan_waves(
        [task("t1", depends_on=[]), task("t2", depends_on=[]), task("t3", depends_on=[])]
    )
    assert waves == [[0, 1, 2]]


def test_a_gather_step_waits_for_the_ones_it_names():
    # The shape this exists for: two independent pieces of research, then one
    # write-up that needs both.
    waves = plan_waves(
        [
            task("research-a", depends_on=[]),
            task("research-b", depends_on=[]),
            task("write-up", depends_on=["research-a", "research-b"]),
        ]
    )
    assert waves == [[0, 1], [2]]


def test_a_wave_keeps_the_order_the_leader_wrote():
    waves = plan_waves(
        [task("c", depends_on=[]), task("a", depends_on=[]), task("b", depends_on=[])]
    )
    # Not sorted by id, not by completion — by the plan. The record should read
    # the way the plan does.
    assert waves == [[0, 1, 2]]


def test_a_half_declared_plan_still_schedules():
    # One task says it is independent, the rest say nothing. The ones that said
    # nothing still chain off whatever precedes them.
    waves = plan_waves([task("t1"), task("t2", depends_on=[]), task("t3")])
    assert waves == [[0, 1], [2]]


def test_every_task_is_scheduled_exactly_once():
    tasks = [
        task("a", depends_on=[]),
        task("b", depends_on=["a"]),
        task("c", depends_on=["a"]),
        task("d", depends_on=["b", "c"]),
    ]
    waves = plan_waves(tasks)
    flat = [i for wave in waves for i in wave]
    assert sorted(flat) == [0, 1, 2, 3]
    assert waves == [[0], [1, 2], [3]]


def test_a_cycle_that_reached_here_runs_rather_than_hangs():
    # The planner refuses cycles, so this only guards a corrupted plan. Running
    # the rest in listed order is worse than a correct schedule and far better
    # than a mission that never ends.
    waves = plan_waves([task("a", depends_on=["b"]), task("b", depends_on=["a"])])
    assert [i for wave in waves for i in wave] == [0, 1]


def test_a_dependency_on_something_outside_the_plan_is_not_waited_for():
    waves = plan_waves([task("a", depends_on=["ghost"]), task("b", depends_on=["a"])])
    assert waves == [[0], [1]]


def test_the_cap_is_small_enough_to_not_look_like_abuse():
    # Every task in a wave is a separate conversation with the same endpoint.
    assert 1 < MAX_PARALLEL <= 5


# ---- what the planner refuses -------------------------------------------


def plan(*tasks) -> Plan:
    return Plan.model_validate({"tasks": tasks})


def test_a_dependency_on_a_task_that_does_not_exist_is_rejected():
    problem = _check_deps(plan(task("t1", depends_on=["nope"])))
    assert problem is not None
    # Named, and the real ids listed, so the retry can fix it.
    assert "nope" in problem and "t1" in problem


def test_a_task_waiting_for_itself_is_rejected():
    problem = _check_deps(plan(task("t1", depends_on=["t1"])))
    assert problem is not None and "itself" in problem


def test_a_cycle_is_rejected():
    problem = _check_deps(
        plan(task("a", depends_on=["b"]), task("b", depends_on=["a"]))
    )
    assert problem is not None and "wait on each other" in problem


def test_duplicate_ids_are_rejected():
    # Two tasks sharing an id makes every dependency on it ambiguous.
    problem = _check_deps(plan(task("t1"), task("t1")))
    assert problem is not None and "unique" in problem


def test_a_plain_sequential_plan_is_accepted():
    assert _check_deps(plan(task("t1"), task("t2"), task("t3"))) is None


def test_an_implicit_edge_can_still_deadlock_and_is_caught():
    """The one a naive cycle check misses.

    `t2` has no `depends_on`, so it implicitly waits for `t1` — and `t1` waits
    for `t2`. Neither declares a cycle, and there is one.
    """
    problem = _check_deps(plan(task("t1", depends_on=["t2"]), task("t2")))
    assert problem is not None and "wait on each other" in problem


# ---- and the plan says so out loud --------------------------------------


def test_the_plan_message_says_what_runs_together():
    # Running two things at once happens because the leader claimed they are
    # independent. A claim nobody can read is not one the approval gate can be
    # used to check.
    text = _plan_text(
        [
            task("a", seat=1, depends_on=[]),
            task("b", seat=2, depends_on=[]),
            task("c", seat=1, depends_on=["a", "b"]),
        ]
    )
    assert "At the same time: 1, 2" in text
    assert "3." in text


def test_a_sequential_plan_says_nothing_extra():
    # Nothing shares a wave, so there is nothing to add. A line reading
    # "At the same time: 1" on every plan would be noise.
    text = _plan_text([task("a"), task("b")])
    assert "At the same time" not in text


# ---- and it actually overlaps -------------------------------------------


@pytest.mark.anyio
async def test_a_wave_really_runs_at_the_same_time():
    """Not a schedule on paper — the coroutines overlap in time."""
    running = 0
    peak = 0

    async def work(_index: int) -> None:
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1

    waves = plan_waves([task("a", depends_on=[]), task("b", depends_on=[])])
    for wave in waves:
        await asyncio.gather(*(work(i) for i in wave))

    assert peak == 2
