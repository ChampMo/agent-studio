"""A mission waiting on a person is not a mission working (§10, §16.4).

Measured on two real builds, both stopped as `budget_exceeded` at the
900-second limit:

    Unit price comparer    ran 1314s, 1217s of it waiting for approval  (93%)
    Sales CSV summariser   ran 1302s, 1176s of it waiting for approval  (90%)

The work took 97 and 126 seconds. Everything else was the clock running while a
command sat on screen waiting to be read — which is exactly what the approval
gate is for. So turning the gate on made runs die of the timeout, and the
harder someone looked at a command before approving it, the more likely the
mission was to be killed for it.

Only the clock stops. Tokens, calls and supersteps were spent and stay spent:
waiting does not give any of them back.
"""

from __future__ import annotations

import pytest

from agentd.core.budget import BudgetExceeded, BudgetLimits, BudgetTracker


def limits(**over) -> BudgetLimits:
    base = dict(
        max_llm_calls=50, max_supersteps=50, max_tokens=1_000_000, timeout_sec=100
    )
    return BudgetLimits(**{**base, **over})


class Clock:
    """A hand-wound clock, so the test measures the rule and not the machine."""

    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def tick(self, seconds: float) -> None:
        self.now += seconds


def test_time_spent_waiting_does_not_count_against_the_limit():
    clock = Clock()
    budget = BudgetTracker(limits(), clock=clock)

    clock.tick(10)  # working
    with budget.paused_for_a_person():
        clock.tick(600)  # someone reading a command
    clock.tick(20)  # working again

    assert budget.elapsed_sec == 30
    budget.check()  # 630 seconds of wall clock, 30 of work, limit 100


def test_the_clock_is_held_while_the_question_is_still_open():
    # Read *during* the wait, which is when the mission's own header reads it.
    clock = Clock()
    budget = BudgetTracker(limits(), clock=clock)
    clock.tick(10)
    with budget.paused_for_a_person():
        clock.tick(500)
        assert budget.elapsed_sec == 10
        clock.tick(500)
        assert budget.elapsed_sec == 10


def test_several_waits_all_come_off():
    clock = Clock()
    budget = BudgetTracker(limits(), clock=clock)
    for _ in range(4):
        clock.tick(5)
        with budget.paused_for_a_person():
            clock.tick(200)
    assert budget.elapsed_sec == 20


def test_a_wait_inside_a_wait_does_not_restart_the_clock():
    # A tool approval inside a turn that is itself inside a paused graph. The
    # outer wait owns the pause; if the inner one ended it, the rest of the
    # outer wait would start counting again.
    clock = Clock()
    budget = BudgetTracker(limits(), clock=clock)
    with budget.paused_for_a_person():
        clock.tick(100)
        with budget.paused_for_a_person():
            clock.tick(100)
        clock.tick(100)
    assert budget.elapsed_sec == 0


def test_work_still_runs_out_of_time():
    # The limit is not weakened, only pointed at the right thing.
    clock = Clock()
    budget = BudgetTracker(limits(timeout_sec=60), clock=clock)
    with budget.paused_for_a_person():
        clock.tick(10_000)
    clock.tick(61)
    with pytest.raises(BudgetExceeded) as raised:
        budget.check()
    assert raised.value.kind == "time"


def test_waiting_gives_no_tokens_back():
    # Only the clock stops. What was spent stays spent.
    clock = Clock()
    budget = BudgetTracker(limits(max_tokens=100), clock=clock)
    budget.record_call({"inputTokens": 60, "outputTokens": 40})
    with budget.paused_for_a_person():
        clock.tick(5_000)
    with pytest.raises(BudgetExceeded) as raised:
        budget.check()
    assert raised.value.kind == "tokens"


def test_the_snapshot_reports_working_time_not_wall_clock():
    # The rail draws this. A meter counting the reader's own thinking time is
    # the meter and the limit measuring different things (§1).
    clock = Clock()
    budget = BudgetTracker(limits(), clock=clock)
    clock.tick(7)
    with budget.paused_for_a_person():
        clock.tick(900)
    assert budget.snapshot()["time"]["used"] == 7
