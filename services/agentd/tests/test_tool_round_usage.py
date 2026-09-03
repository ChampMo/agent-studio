"""A round that only calls tools still spent money (§1).

`run_agent_turn` publishes no `agent.message` for a round that asked for tools
and said nothing — an empty bubble would suggest the agent said nothing when in
fact it acted — and the usage was inside that message, so it went too.

The budget guard counted those tokens regardless. Seen live on a research run:
two `web_fetch` results of 15,321 and 20,018 characters, re-sent on every
following turn, spent the whole 200,000-token budget, and the mission's own
timeline totalled **7,540**. The meter and the limit beside it were measuring
different runs, which is the thing §1 exists to stop — and the earlier fix for
that symptom (counting the same four fields) could not have closed it, because
whole rounds emitted nothing to count.
"""

from __future__ import annotations

import pytest

from agentd.agents.runtime import run_agent_turn
from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.tools.base import ToolContext, ToolResult
from agentd.tools.execution import ToolBox
from agentd.tools.registry import ToolSpec
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    Message,
    TextChunk,
    ToolCallChunk,
    Usage,
)

pytestmark = pytest.mark.anyio


class Provider:
    """One round of tool calls, then one round of words."""

    kind = "openai_compatible"

    def __init__(self):
        self.rounds = 0

    async def stream(self, req: ChatRequest, caps: Capabilities):
        self.rounds += 1
        if self.rounds == 1:
            yield ToolCallChunk(call_id="c1", name="noop", arguments_json="{}")
            yield DoneChunk("tool_use", Usage(input_tokens=900, output_tokens=40))
        else:
            yield TextChunk("done")
            yield DoneChunk("stop", Usage(input_tokens=1200, output_tokens=20))

    async def aclose(self):
        return None


async def _noop(ctx, **kwargs):
    return ToolResult(content="nothing happened", summary="did nothing")


NOOP = ToolSpec(
    id="noop",
    title="Noop",
    description="does nothing",
    risk="safe",
    input_schema={"type": "object", "properties": {}},
    handler=_noop,
)


def one_tool() -> ToolBox:
    return ToolBox(
        specs=[NOOP],
        context=ToolContext(mission_id="m-1", agent_id="a-1", workspace_root=None),
    )


async def drain(tools):
    budget = BudgetTracker(
        BudgetLimits(
            max_llm_calls=10, max_supersteps=10, max_tokens=1_000_000, timeout_sec=60
        )
    )
    provider = Provider()
    items = []
    async for item in run_agent_turn(
        provider=provider,
        caps=Capabilities(tool_calling=True),
        request=ChatRequest(
            model="m1", messages=[Message("user", "go")], max_tokens=100
        ),
        mission_id="m-1",
        agent_id="a-1",
        budget=budget,
        tools=tools,
    ):
        items.append(item)
    return items, budget


def totals(items):
    """What the *log* says was spent, counted the way the rail counts it."""
    spent = 0
    for item in items:
        usage = (item.get("payload") or {}).get("usage")
        if usage:
            spent += sum(
                usage.get(k, 0) or 0
                for k in (
                    "inputTokens",
                    "outputTokens",
                    "cacheReadTokens",
                    "cacheWriteTokens",
                )
            )
    return spent


async def test_the_log_accounts_for_every_token_the_guard_counted():
    items, budget = await drain(one_tool())

    on_the_log = totals(items)
    # 900 + 40 for the tool round, 1200 + 20 for the round that spoke.
    assert on_the_log == 2160
    assert on_the_log == budget.tokens_used, (
        "the meter and the limit beside it are measuring different runs"
    )


async def test_the_tool_round_still_publishes_no_message():
    # The reason the usage went missing is still a good reason for the message
    # to be absent: an empty bubble reads as an agent that said nothing.
    items, _ = await drain(one_tool())
    messages = [i for i in items if i.get("type") == "agent.message"]
    assert len(messages) == 1
    assert messages[0]["payload"]["content"] == "done"


async def test_the_cost_is_attributed_and_tied_to_its_round():
    items, _ = await drain(one_tool())
    usage_events = [i for i in items if i.get("type") == "agent.usage"]
    assert len(usage_events) == 1
    payload = usage_events[0]["payload"]
    assert payload["agentId"] == "a-1"
    # The round it paid for, so it can be matched to the tool calls beside it.
    assert payload["messageId"]
    assert payload["usage"]["inputTokens"] == 900


class Talker:
    """Says something and asks for nothing."""

    kind = "openai_compatible"

    async def stream(self, req: ChatRequest, caps: Capabilities):
        yield TextChunk("done")
        yield DoneChunk("stop", Usage(input_tokens=1200, output_tokens=20))

    async def aclose(self):
        return None


async def test_a_round_that_speaks_does_not_report_its_cost_twice():
    # The usage rides on the message, as it always did. A second event would
    # double every ordinary turn on the meter.
    budget = BudgetTracker(
        BudgetLimits(
            max_llm_calls=10, max_supersteps=10, max_tokens=1_000_000, timeout_sec=60
        )
    )
    items = []
    async for item in run_agent_turn(
        provider=Talker(),
        caps=Capabilities(tool_calling=True),
        request=ChatRequest(
            model="m1", messages=[Message("user", "go")], max_tokens=100
        ),
        mission_id="m-1",
        agent_id="a-1",
        budget=budget,
    ):
        items.append(item)

    assert [i.get("type") for i in items].count("agent.usage") == 0
    assert totals(items) == 1220 == budget.tokens_used
