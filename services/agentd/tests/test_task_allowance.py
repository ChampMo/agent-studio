"""One task must not spend the whole run (§10).

Measured on a real build. A five-agent team was asked for a three-file web app
with a review, an audit and a QA pass behind it. The implementation task used
**201,882 tokens of a 200,000 budget** and the other three never started:

    stopped at the tokens limit (201882/200000) — 1 of 4 tasks done.
    never started: Review UI/UX; Audit requirements; Run QA checks

The files were written and correct. Nobody checked them, which is the worst
half to lose — a run cut short does not lose a random quarter of its value, it
loses precisely the part that was going to say whether the rest is true.

Where it went, from the log: **79% was `cacheReadTokens`** — the conversation
being re-sent on every one of thirteen calls, growing as the files it had
written accumulated in it. The last call spent 20,864 tokens of context to
produce 303 tokens of answer.

So a task now gets a ceiling of its own, and reaching it ends **that task**
rather than the mission. The difference is everything: with a mission-level
`BudgetExceeded` you get files nobody checked; with a task-level stop you get
files and three reviewers saying what is wrong with them.
"""

from __future__ import annotations

from agentd.tools.execution import MAX_TOOL_ROUNDS
from agentd.orchestrator.graph import (
    MIN_TASK_ALLOWANCE,
    RESERVE_PER_QUEUED_TASK,
    task_allowance,
)


def test_the_last_task_may_use_everything_that_is_left():
    # Nothing queued behind it, so nothing to hold back for.
    assert task_allowance(50_000, queued_after=0) == 50_000


def test_a_task_leaves_room_for_the_ones_behind_it():
    # The run that found this: 200,000 to spend, three tasks queued after.
    allowed = task_allowance(200_000, queued_after=3)
    assert allowed == 200_000 - 3 * RESERVE_PER_QUEUED_TASK
    # And what it leaves is enough for each of them to actually run.
    assert 200_000 - allowed >= 3 * MIN_TASK_ALLOWANCE


def test_it_is_a_floor_not_an_even_share():
    """A task that needs most of the budget may still have it.

    Splitting four ways would have capped the implementation at 50,000 and
    produced no files at all. The reserve only protects the minimum the queued
    tasks need, and everything above that is still available.
    """
    allowed = task_allowance(200_000, queued_after=3)
    assert allowed > 200_000 / 4


def test_a_task_always_gets_enough_to_look_before_it_reports():
    # Reporting "stopped" without having read anything is worse than not
    # running: it puts a confident empty answer on the record.
    assert task_allowance(1_000, queued_after=5) == MIN_TASK_ALLOWANCE
    assert task_allowance(0, queued_after=99) == MIN_TASK_ALLOWANCE


def test_a_nearly_spent_run_still_gives_each_task_the_minimum():
    assert task_allowance(30_000, queued_after=10) == MIN_TASK_ALLOWANCE


def test_the_reserve_is_enough_to_read_a_small_project_and_answer():
    # The three review tasks each needed to read ~21KB of files — about six
    # thousand tokens — and write a paragraph.
    assert RESERVE_PER_QUEUED_TASK >= 12_000


def test_the_real_run_would_have_had_room_for_all_four():
    """The case this exists for: 200,000 total, four tasks.

    The implementation must still get the lion's share — that is the whole
    argument for a floor rather than a split, and splitting 200,000 four ways
    was measured to produce nothing at all — while the three reviews keep
    enough between them to actually run.

    This asserted `first == 140_000` when the reserve was 20,000 per queued
    task. The reserve is now the same number as the floor, so the split is
    101,696 / 98,304 rather than 140,000 / 60,000. The property is unchanged
    and the reviews are better off: 60,000 between three of them was 20,000
    each, which is below what a task needs to take a turn — the exact fault
    that made every late task on the ZenBrew run fail.
    """
    first = task_allowance(200_000, queued_after=3)
    left = 200_000 - first

    # The implementation still gets the largest single share.
    assert first > left / 3
    # And it is not squeezed towards the four-way split this exists to avoid.
    assert first >= 200_000 // 2

    # Each review can still take a turn — the thing 20,000 each could not do.
    assert left // 3 >= MIN_TASK_ALLOWANCE


# ---- and the turn actually stops -----------------------------------------

import asyncio
import re

import pytest

from agentd.agents.runtime import run_agent_turn
from agentd.core.budget import BudgetExceeded, BudgetLimits, BudgetTracker
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    Message,
    TextChunk,
    ToolCallChunk,
    Usage,
)
from agentd.tools.base import ToolContext, ToolResult
from agentd.tools.execution import ToolBox
from agentd.tools.registry import ToolSpec

pytestmark = pytest.mark.anyio


async def _noop(ctx, **kwargs):
    return ToolResult(content="nothing happened", summary="did nothing")


def one_tool() -> ToolBox:
    return ToolBox(
        specs=[
            ToolSpec(
                id="noop",
                title="Noop",
                description="does nothing",
                risk="safe",
                input_schema={"type": "object", "properties": {}},
                handler=_noop,
            )
        ],
        context=ToolContext(mission_id="m-1", agent_id="a-1", workspace_root=None),
    )


class Grinder:
    """Asks for a tool every round and never converges — the shape that ran up
    the bill: each round costs, and the cost is mostly re-sent context."""

    kind = "openai_compatible"

    def __init__(self):
        self.calls = 0

    async def stream(self, req: ChatRequest, caps: Capabilities):
        self.calls += 1
        yield ToolCallChunk(call_id=f"c{self.calls}", name="noop", arguments_json="{}")
        yield DoneChunk(
            "tool_use", Usage(input_tokens=100, output_tokens=100, cache_read_tokens=4_800)
        )

    async def aclose(self):
        return None


async def drain(spend_ceiling):
    budget = BudgetTracker(
        BudgetLimits(
            max_llm_calls=500, max_supersteps=500, max_tokens=1_000_000, timeout_sec=600
        )
    )
    model = Grinder()
    items = []
    async for item in run_agent_turn(
        provider=model,
        caps=Capabilities(tool_calling=True),
        request=ChatRequest(model="m", messages=[Message("user", "go")], max_tokens=100),
        mission_id="m-1",
        agent_id="a-1",
        budget=budget,
        tools=one_tool(),
        spend_ceiling=spend_ceiling,
    ):
        items.append(item)
    return items, budget, model


async def test_a_turn_that_burns_its_share_stops_itself():
    items, budget, model = await drain(spend_ceiling=15_000)
    codes = [
        i["payload"].get("code") for i in items if i.get("type") == "error"
    ]
    assert "task_budget_spent" in codes
    # Stopped early rather than grinding to the 12-round cap.
    assert model.calls < 12
    assert budget.tokens_used >= 15_000


async def test_it_does_not_end_the_mission():
    # The point of the whole change. `BudgetExceeded` would have propagated out
    # of here and ended the run; this yields an event and returns.
    items, _budget, _model = await drain(spend_ceiling=15_000)
    assert items[-1]["type"] == "agent.status"
    assert items[-1]["payload"]["status"] == "idle"


async def test_no_ceiling_means_the_mission_ceiling_is_the_only_one():
    _items, _budget, model = await drain(spend_ceiling=None)
    # Runs until the round cap, exactly as before — and read off the constant
    # rather than written out. This said `12`, so raising the cap failed a
    # test about *task allowances* for a reason that had nothing to do with
    # them: a second copy of a number is a second thing to update.
    assert model.calls == MAX_TOOL_ROUNDS


async def test_running_out_of_money_and_running_out_of_ideas_are_told_apart():
    items, _budget, _model = await drain(spend_ceiling=None)
    codes = [i["payload"].get("code") for i in items if i.get("type") == "error"]
    assert "tool_rounds_exhausted" in codes
    assert "task_budget_spent" not in codes


# ---- the reserve must not be inside what a task may spend ----------------
#
# Measured on a clean re-run of the same brief, and the run contains both
# halves of the experiment:
#
#   round 1  stopped at 1,533,389 / 1,500,000  -> no handover at all
#   round 2  stopped at 1,485,441 / 1,500,000  -> a full 4,195-char handover
#
# Round 1 went past the ceiling because one task was handed 1,317,230 tokens
# (`task_budget_spent` at seq 193). `task_allowance` was being given
# `remaining_tokens`, which is the raw distance to the ceiling and therefore
# includes the wrap-up reserve. The task spent it, `work_exhausted` fired
# after the fact, and `release_reserve` had nothing to release.


def tracker(limit, used=0):
    from agentd.core.budget import BudgetLimits, BudgetTracker

    t = BudgetTracker(BudgetLimits(max_tokens=limit, max_llm_calls=300,
                                   max_supersteps=300, timeout_sec=7200))
    t.tokens_used = used
    return t


def test_the_working_remainder_holds_the_reserve_back():
    from agentd.core.budget import WRAPUP_RATIO, WRAPUP_TOKENS

    t = tracker(1_500_000)
    held = min(WRAPUP_TOKENS, 1_500_000 * WRAPUP_RATIO)
    assert t.remaining_tokens == 1_500_000
    assert t.remaining_working_tokens == 1_500_000 - held


def test_a_lone_task_cannot_be_offered_the_reserve():
    # The shape of the real failure: one task, nothing queued behind it, so
    # `task_allowance` returns the whole remainder it is given.
    t = tracker(1_500_000)
    allowed = task_allowance(t.remaining_working_tokens, queued_after=0)
    assert allowed < t.remaining_tokens
    # Spending every token it is allowed still leaves the wrap-up its share.
    assert t.limits.max_tokens - allowed >= t.remaining_tokens - t.remaining_working_tokens


def test_spending_the_whole_allowance_leaves_the_run_under_its_ceiling():
    """The property that failed: work must stop below the limit, not past it."""
    t = tracker(1_500_000)
    allowed = task_allowance(t.remaining_working_tokens, queued_after=0)
    t.tokens_used = allowed
    assert t.tokens_used < t.limits.max_tokens, "the ceiling was crossed by one task"
    assert t.work_exhausted() is not None, "and the work phase should now stop"
    # And the summary still has something to spend.
    t.release_reserve()
    assert t.remaining_tokens > 0


def test_a_small_budget_still_leaves_a_task_able_to_run():
    # WRAPUP_RATIO exists so a tiny ceiling is not almost entirely reserve.
    t = tracker(40_000)
    assert task_allowance(t.remaining_working_tokens, queued_after=0) >= MIN_TASK_ALLOWANCE


def test_after_the_reserve_is_released_the_two_agree():
    # The wrap-up is what the reserve was kept for, so it may have it.
    t = tracker(1_500_000, used=1_400_000)
    assert t.remaining_working_tokens < t.remaining_tokens
    t.release_reserve()
    assert t.remaining_working_tokens == t.remaining_tokens


# ---- the wrap-up is guaranteed its reserve, even past the ceiling --------
#
# The choice this encodes: a run that overshoots should still be able to say
# where the money went. Losing the handover means paying for the overshoot
# *and* losing the account of it, which is the worst of both.


def test_a_run_that_stopped_where_it_should_gets_no_extra():
    # The common case must be untouched: used + reserve is still under the
    # ceiling, so the ceiling wins and the wrap-up spends inside it.
    from agentd.core.budget import WRAPUP_RATIO, WRAPUP_TOKENS

    limit = 1_500_000
    held = min(WRAPUP_TOKENS, limit * WRAPUP_RATIO)
    t = tracker(limit, used=int(limit - held))   # stopped exactly on the share
    t.release_reserve()
    assert t.remaining_tokens == int(held)
    assert t.tokens_used + t.remaining_tokens == limit, "must not exceed the ceiling"
    t.check()  # and it may run


def test_a_run_that_overshot_still_gets_the_reserve():
    """The failure this exists for.

    Measured: a 60,000-token run crossed its 51,000 working share and then
    spent 20,476 on a single call, ending at 76,839. `check()` raised in
    `summarise_node` and the round produced a 218-character machine note
    instead of a handover.
    """
    from agentd.core.budget import BudgetExceeded, WRAPUP_RATIO, WRAPUP_TOKENS

    limit = 60_000
    held = min(WRAPUP_TOKENS, limit * WRAPUP_RATIO)
    t = tracker(limit, used=76_839)

    # While the team is still working, being over is still over.
    try:
        t.check()
        raise AssertionError("the work phase must still be stopped")
    except BudgetExceeded:
        pass

    t.release_reserve()
    t.check()                                   # the handover may now be written
    assert t.remaining_tokens == int(held)      # exactly the reserve, no more


def test_the_reported_limit_does_not_move():
    """The record has to keep saying what the person actually set."""
    from agentd.core.budget import BudgetExceeded

    t = tracker(60_000, used=76_839)
    t.release_reserve()
    assert t.snapshot()["tokens"]["limit"] == 60_000
    assert t.snapshot()["tokens"]["used"] == 76_839
    # And when the wrap-up itself runs out, the ending names the real number.
    t.tokens_used = 200_000
    try:
        t.check()
        raise AssertionError("should have raised")
    except BudgetExceeded as exc:
        assert exc.limit == 60_000, "an ending must not quote the grace as the limit"


def test_the_other_limits_are_guaranteed_too():
    # A handover needs a call and a superstep, not only tokens. A work phase
    # that used every call would otherwise still silence it.
    t = tracker(60_000)
    t.llm_calls_used = t.limits.max_llm_calls + 5
    t.supersteps_used = t.limits.max_supersteps + 5
    t.release_reserve()
    t.check()


# ---------------------------------------------------------------------------
# A wave of parallel tasks shares one BudgetTracker.
#
# `spend_ceiling` used to be enforced as `budget.tokens_used - spent_at_start`,
# and `budget` is the mission's, shared by every task in the wave through
# `asyncio.gather`. So each sibling's "own" delta was the whole wave's spend.
#
# Off the real PARADOX.ART log (seq 1463-1510), the last wave of round 4:
#
#     agent-1f50683d  21,635 tokens
#     agent-fb8b0d01  12,355 tokens
#     combined        33,990
#
#     seq 1501  task_budget_spent  "... its share of the run's budget (33,990
#     seq 1508  task_budget_spent  "... its share of the run's budget (33,990
#
# Both were stopped, and both reported the *combined* figure as their own.
# The identical pair, re-run sequentially as round 5, both finished — at
# 1,880,269 tokens. The defect cost an entire round.


class Steady:
    """One tool call per round at a known, fixed cost."""

    kind = "openai_compatible"

    def __init__(self, per_round: int):
        self.calls = 0
        self.per_round = per_round

    async def stream(self, req: ChatRequest, caps: Capabilities):
        self.calls += 1
        # A real provider awaits the network on every chunk, so sibling turns
        # in a wave genuinely interleave. Without this the fake runs straight
        # through, `gather` finishes one turn before starting the next, and
        # the shared-counter bug cannot show — the first version of these
        # tests passed on the broken code for exactly that reason.
        await asyncio.sleep(0)
        yield ToolCallChunk(call_id=f"c{self.calls}", name="noop", arguments_json="{}")
        await asyncio.sleep(0)
        yield DoneChunk("tool_use", Usage(input_tokens=self.per_round, output_tokens=0))

    async def aclose(self):
        return None


async def _turn(budget, model, agent_id, spend_ceiling):
    out = []
    async for item in run_agent_turn(
        provider=model,
        caps=Capabilities(tool_calling=True),
        request=ChatRequest(model="m", messages=[Message("user", "go")], max_tokens=100),
        mission_id="m-1",
        agent_id=agent_id,
        budget=budget,
        tools=one_tool(),
        spend_ceiling=spend_ceiling,
    ):
        out.append(item)
    return out


def _shared_budget():
    return BudgetTracker(
        BudgetLimits(
            max_llm_calls=5_000,
            max_supersteps=5_000,
            max_tokens=100_000_000,
            timeout_sec=600,
        )
    )


async def test_a_wave_is_bounded_collectively_not_per_task():
    """The invariant that had no test, and that a "fix" nearly removed.

    `queued_after` counts only *later* waves (graph.py), so every task in the
    current wave is handed the whole working remainder as its ceiling. The
    only thing stopping a wave of N spending N x that remainder is that
    `spend_ceiling` differences the *shared* tracker — so the siblings stop
    collectively at one allowance.

    `test_spending_the_whole_allowance_leaves_the_run_under_its_ceiling`
    covers `queued_after=0`, one task. This is the parallel case, and its
    absence is why counting each turn separately looked like a tidy-up.
    """
    budget = _shared_budget()
    a, b = Steady(1_000), Steady(1_000)
    await asyncio.gather(
        _turn(budget, a, "a-1", 10_000), _turn(budget, b, "a-2", 10_000)
    )
    # Together, not each: ~10,000 between them, not 10,000 apiece.
    assert budget.tokens_used <= 12_000, (
        f"the wave spent {budget.tokens_used:,} against one task's 10,000 "
        "allowance — the wave is no longer collectively bounded"
    )
    assert a.calls + b.calls <= 12


async def test_the_reported_figure_is_this_task_s_own_spend():
    """Enforcement is collective; the sentence is personal.

    On the real run two siblings spending 21,635 and 12,355 were each told
    they had used "(33,990 tokens)" — the pair's total, printed twice as a
    personal figure. The bound was right; the number in the message was
    false of the task it was attached to.
    """
    budget = _shared_budget()
    fast, slow = Steady(2_500), Steady(700)
    out = await asyncio.gather(
        _turn(budget, fast, "a-1", 6_000), _turn(budget, slow, "a-2", 6_000)
    )

    def figure(items):
        for i in items:
            if i.get("type") == "error" and i["payload"].get("code") == "task_budget_spent":
                return int(
                    re.search(r"\(([\d,]+) tokens\)", i["payload"]["message"])
                    .group(1)
                    .replace(",", "")
                )
        return None

    said_fast, said_slow = figure(out[0]), figure(out[1])
    assert said_fast is not None and said_slow is not None
    # Each says what it actually spent, so the two cannot agree.
    assert said_fast == fast.calls * 2_500
    assert said_slow == slow.calls * 700
    assert said_fast != said_slow, (
        f"both tasks reported {said_fast} — that is the shared-counter bug"
    )
    # And neither claims the pair's total as its own.
    assert said_fast + said_slow == budget.tokens_used


# ---------------------------------------------------------------------------
# A task may never be rationed below what one of its own replies may emit.
#
# Reported as "it keeps failing": ZenBrew, 200,000 per round, an eight-task
# plan, three rounds, and the same build tasks failed in every one.
#
#   MIN_TASK_ALLOWANCE   12,000   <- what a whole task could spend
#   MAX_TOKENS_PER_TASK  16,384   <- what ONE reply's output was permitted
#
# 14 of 17 task starts got that floor, and every `task_produced_nothing` on
# that log is immediately preceded by a `task_budget_spent` from the same
# agent. The failures had 2-3 replies against 4-6 for the successes: a build
# task spends its first replies looking at the workspace, so it was stopped
# before it ever wrote, and was then recorded `failed` — the app blaming the
# agent for a ration it set itself.


def test_a_task_is_never_rationed_below_one_of_its_own_replies():
    """The floor has to survive a single reply, or the turn cannot act.

    This is the check that would have caught the ZenBrew run on the day the
    two constants were written, and it is an inequality rather than a number
    so that raising either one alone cannot reintroduce it.
    """
    from agentd.orchestrator.graph import MAX_TOKENS_PER_TASK, MIN_TASK_ALLOWANCE

    assert MIN_TASK_ALLOWANCE >= 2 * MAX_TOKENS_PER_TASK, (
        f"a task may spend {MIN_TASK_ALLOWANCE:,} while one of its replies may "
        f"emit {MAX_TOKENS_PER_TASK:,} — it gets one reply and cannot both look "
        "and write"
    )


def test_the_reserve_is_what_a_queued_task_actually_gets():
    """One number for one idea.

    The reserve held back 20,000 per queued task in order to hand each of them
    a floor of 12,000. Two figures for "what a queued task needs", and the
    smaller one was what they were given — so the withholding was sized for a
    task that does not exist.
    """
    from agentd.orchestrator.graph import MIN_TASK_ALLOWANCE, RESERVE_PER_QUEUED_TASK

    assert RESERVE_PER_QUEUED_TASK == MIN_TASK_ALLOWANCE


def test_no_task_on_the_real_run_is_offered_less_than_a_turn():
    """Replayed from ZenBrew round 1, using what it actually spent.

    The first version of this test walked eight tasks spending the floor each
    time, and **passed on the broken constants** — spending 12,000 a task
    never depletes 176,000, so the starvation never appeared. It proved
    nothing. These are the real cumulative-spend figures at each
    `mission.progress running`, read off that mission's log.

    The invariant is a disjunction, and both halves matter: a task is either
    offered enough to take a turn, or it is not started at all. What must
    never happen — what happened fourteen times on that run — is a task
    started on a ration below one of its own replies.
    """
    from agentd.orchestrator.graph import (
        MAX_TOKENS_PER_TASK,
        MIN_TASK_ALLOWANCE,
        task_allowance,
    )

    working_ceiling = 200_000 - 24_000
    # (tokens already spent in the round, tasks still queued behind this one)
    real_starts = [
        (14_644, 7), (42_756, 6), (87_111, 5), (99_908, 4),
        (99_908, 3), (147_287, 2), (161_290, 1), (180_954, 0),
    ]

    starved = []
    for spent, queued_after in real_starts:
        remaining = max(0, working_ceiling - spent)
        if remaining < MIN_TASK_ALLOWANCE:
            continue                      # never started — honest, and reported
        allowed = task_allowance(remaining, queued_after)
        if allowed < 2 * MAX_TOKENS_PER_TASK:
            starved.append((spent, allowed))

    assert starved == [], (
        "tasks started on a ration below one of their own replies: "
        + "; ".join(f"at {s:,} spent -> offered {a:,}" for s, a in starved)
    )


def test_a_tiny_ceiling_still_runs_something():
    """The guard must not turn a small budget into a round that does nothing.

    `remaining_working_tokens < MIN_TASK_ALLOWANCE` stops the wave loop
    starting more work. A ceiling may legally be set as low as 1,000, where
    that condition is true before anything has run — so the check is gated on
    `at > 0` and the first wave always gets a go. Asserted here on the
    arithmetic, because the alternative is a silent regression for anyone who
    sets a deliberately small budget.
    """
    from agentd.core.budget import BudgetLimits, BudgetTracker
    from agentd.orchestrator.graph import MIN_TASK_ALLOWANCE

    tiny = BudgetTracker(
        BudgetLimits(max_llm_calls=40, max_supersteps=60, max_tokens=30_000,
                     timeout_sec=900)
    )
    # The condition the loop tests is already true at the very first wave...
    assert tiny.remaining_working_tokens < MIN_TASK_ALLOWANCE
    # ...which is exactly why it may only be consulted from the second wave on.


# ---------------------------------------------------------------------------
# A task this app cut off is not a task that failed.
#
# Reported twice, in the same words both times: a round that runs out is fine,
# a plan the model wrote for itself coming back `failed` is not. On the run
# behind that report every red task was this app stopping the turn at a ration
# it had set — `task_budget_spent` immediately before every single
# `task_produced_nothing`.


def test_a_task_stopped_at_a_ceiling_is_not_reported_as_failed():
    from agentd.agents.runner import unfinished_note

    note = unfinished_note(
        {
            "t1": ("done", "Scope brief"),
            "t2": ("stopped", "Build Hero and cursor-reactive MatchaScene"),
            "t3": ("pending", "Independent QA"),
        }
    )
    assert "ran out of room: Build Hero and cursor-reactive MatchaScene" in note
    assert "never started: Independent QA" in note
    # The word the person specifically did not want to see about it.
    assert "did not finish: Build Hero" not in note


def test_failed_still_means_failed():
    """`stopped` must not launder the case the file-deliverable rule exists for.

    A turn that had the room, answered, and did not write the file it was
    asked for is the agent's failure, and this project has already shipped a
    round recorded `completed` over an empty folder once.
    """
    from agentd.agents.runner import unfinished_note

    note = unfinished_note({"t1": ("failed", "Build css/style.css")})
    assert "did not finish: Build css/style.css" in note
    assert "ran out of room" not in note


def test_a_stopped_task_still_keeps_the_run_from_saying_completed():
    """The word changes; the accounting does not.

    `stopped` is not a softer `done`. A run whose tasks were cut off did not
    do what it was asked, and `ending_for` must go on refusing `completed` —
    otherwise this would be the third time this app credited a team with work
    it had not finished.
    """
    from agentd.agents.runner import ending_for

    reason, _summary = ending_for(
        "completed", "", {"t1": ("done", "a"), "t2": ("stopped", "b")}
    )
    assert reason != "completed"


def test_an_unknown_state_is_still_named(  # noqa: D103
):
    # §8: a state this build has never heard of is filed with `pending` rather
    # than dropped. An unnamed leftover is worse than one filed imprecisely.
    from agentd.agents.runner import unfinished_note

    note = unfinished_note({"t1": ("teleported", "Something from a later build")})
    assert "Something from a later build" in note
