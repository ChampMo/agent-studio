"""M1 proof #2: the budget guard actually stops things (PROJECT_BRIEF.md §10, §10.1)."""

from __future__ import annotations

import pytest

from agentd.core.budget import (
    BudgetExceeded,
    BudgetLimits,
    BudgetTracker,
    resolve_limits,
)
from agentd.core import budget as budget_mod
from agentd.core.config import AppBudget


def limits(**kw) -> BudgetLimits:
    base = dict(max_llm_calls=10, max_supersteps=10, max_tokens=1000, timeout_sec=60)
    return BudgetLimits(**{**base, **kw})


def test_precedence_is_per_field_not_whole_object():
    """A mission that overrides only the timeout must keep the team's token
    ceiling, not silently fall back to the app default for everything else."""
    resolved = resolve_limits(
        mission={"timeout_sec": 30},
        team_default={"max_tokens": 5_000, "timeout_sec": 600},
        app_default=AppBudget(max_tokens=200_000, timeout_sec=900),
    )
    assert resolved.timeout_sec == 30       # mission wins
    assert resolved.max_tokens == 5_000     # team still applies
    assert resolved.max_llm_calls == AppBudget().max_llm_calls  # app fills the rest


def test_clamp_is_what_makes_the_ceiling_real():
    """Output tokens are only known once a stream ends, so a post-hoc check can
    report an overrun but never prevent one. The clamp prevents it."""
    t = BudgetTracker(limits(max_tokens=1000))
    assert t.clamp_max_tokens(64_000) == 1000

    t.record_call({"inputTokens": 400, "outputTokens": 400})
    assert t.clamp_max_tokens(64_000) == 200

    t.record_call({"inputTokens": 100, "outputTokens": 100})
    assert t.clamp_max_tokens(64_000) == 0  # cannot ask for another token


def test_tokens_limit_stops_the_mission():
    t = BudgetTracker(limits(max_tokens=100))
    t.record_call({"inputTokens": 60, "outputTokens": 60})
    with pytest.raises(BudgetExceeded) as exc:
        t.check()
    assert exc.value.kind == "tokens"


def test_llm_call_limit_stops_the_mission():
    t = BudgetTracker(limits(max_llm_calls=2))
    t.record_call({"inputTokens": 1, "outputTokens": 1})
    t.check()
    t.record_call({"inputTokens": 1, "outputTokens": 1})
    with pytest.raises(BudgetExceeded) as exc:
        t.check()
    assert exc.value.kind == "llm_calls"


def test_time_limit_stops_the_mission():
    now = [0.0]
    t = BudgetTracker(limits(timeout_sec=10), clock=lambda: now[0])
    now[0] = 9.0
    t.check()
    now[0] = 10.5
    with pytest.raises(BudgetExceeded) as exc:
        t.check()
    assert exc.value.kind == "time"


def test_warning_fires_at_eighty_percent_once_per_kind():
    t = BudgetTracker(limits(max_tokens=1000, max_llm_calls=100))

    assert t.record_call({"inputTokens": 300, "outputTokens": 300}) == []  # 60%

    warnings = t.record_call({"inputTokens": 100, "outputTokens": 100})    # 80%
    assert len(warnings) == 1
    assert warnings[0]["type"] == "budget.warning"
    assert warnings[0]["payload"]["kind"] == "tokens"
    assert warnings[0]["payload"]["limit"] == 1000

    # Crossing further must not spam the timeline.
    assert t.record_call({"inputTokens": 50, "outputTokens": 50}) == []


def test_cached_tokens_count_against_the_ceiling():
    """Cache reads and writes are billed differently but still occupy context,
    so they spend the token budget like anything else."""
    t = BudgetTracker(limits(max_tokens=1000))
    t.record_call(
        {"inputTokens": 100, "outputTokens": 100,
         "cacheReadTokens": 300, "cacheWriteTokens": 200}
    )
    assert t.tokens_used == 700


def test_warning_drafts_carry_no_seq_or_ts():
    """budget.warning is a draft like any other: the bus stamps it (§4.1)."""
    t = BudgetTracker(limits(max_tokens=10))
    warnings = t.record_call({"inputTokens": 5, "outputTokens": 4})
    assert warnings and set(warnings[0]) == {"type", "payload"}


# ---- the wrap-up reserve -------------------------------------------------
#
# Running out used to stop a run where it stood, so a build that had written
# seven files and not started six tasks ended with no account of itself beyond
# a number. A slice of each limit is held back for the leader to say what was
# done and what was not.


def test_the_working_share_runs_out_before_the_limit_does():
    # Big enough that the flat reserve applies rather than the fraction.
    b = BudgetTracker(limits(max_tokens=1_000_000, timeout_sec=100_000))
    b.tokens_used = 1_000_000 - budget_mod.WRAPUP_TOKENS - 1
    assert b.work_exhausted() is None
    b.tokens_used += 1
    spent = b.work_exhausted()
    assert spent is not None and spent[0] == "tokens"
    # And it is not an ending: the ceiling itself is still untouched.
    b.check()


def test_releasing_the_reserve_hands_it_to_the_wrap_up():
    b = BudgetTracker(limits(max_tokens=1_000_000, timeout_sec=100_000))
    b.tokens_used = 1_000_000 - budget_mod.WRAPUP_TOKENS
    assert b.work_exhausted() is not None
    b.release_reserve()
    # The summary turn may now spend what was kept for it...
    assert b.work_exhausted() is None
    b.check()
    # ...but not past the ceiling, which never moved.
    b.tokens_used = 1_000_000
    with pytest.raises(BudgetExceeded):
        b.check()


def test_a_small_budget_keeps_a_working_share_rather_than_being_all_reserve():
    # A flat 90-second reserve against a 60-second timeout left nothing able to
    # run at all, so the reserve is capped at a fraction of the limit.
    b = BudgetTracker(limits(max_tokens=10_000, timeout_sec=60))
    assert b.work_exhausted() is None
    b.tokens_used = int(10_000 * (1 - budget_mod.WRAPUP_RATIO))
    assert b.work_exhausted() is not None


def test_a_ceiling_of_one_call_reserves_nothing_and_simply_runs_out():
    # Reserving the only call would leave nothing able to run. The ceiling is
    # reached instead, which is the honest outcome for a budget that small.
    b = BudgetTracker(limits(max_llm_calls=1))
    assert b._reserve()["llm_calls"] == 0


def test_nothing_is_marked_as_stopping_early_on_its_own():
    # `stopped_early` is set by whoever acts on `work_exhausted`, so a tracker
    # that was merely asked never records an ending that did not happen.
    b = BudgetTracker(limits(max_tokens=1_000))
    b.tokens_used = 1_000
    assert b.work_exhausted() is not None
    assert b.stopped_early is None
