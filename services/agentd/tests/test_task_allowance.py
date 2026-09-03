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
    """The case this exists for, with its real numbers.

    200,000 total, four tasks. The implementation gets 140,000 — more than it
    had spent by the time all three files were on disk — and the three reviews
    have 60,000 between them.
    """
    first = task_allowance(200_000, queued_after=3)
    assert first == 140_000
    left = 200_000 - first
    assert left // 3 >= MIN_TASK_ALLOWANCE


# ---- and the turn actually stops -----------------------------------------

import pytest

from agentd.agents.runtime import run_agent_turn
from agentd.core.budget import BudgetLimits, BudgetTracker
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
    # Runs until the round cap, exactly as before.
    assert model.calls == 12


async def test_running_out_of_money_and_running_out_of_ideas_are_told_apart():
    items, _budget, _model = await drain(spend_ceiling=None)
    codes = [i["payload"].get("code") for i in items if i.get("type") == "error"]
    assert "tool_rounds_exhausted" in codes
    assert "task_budget_spent" not in codes
