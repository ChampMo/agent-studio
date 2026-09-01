"""Search the endpoint runs for itself (§16.8).

Verified against DeepSeek's `/anthropic` endpoint before any of this was
written: sending Anthropic's server-tool spec came back with `server_tool_use`
and `web_search_tool_result` blocks, the search having already happened. The
results carried `encrypted_content` — opaque to this app.

So the tests are about the one thing that matters here, which is not that it
works: it is that the record says who did it. A search this app never saw, could
not refuse and cannot read must not appear on the timeline looking like a tool
call that passed the approval gate.
"""

from __future__ import annotations

import pytest

from agentd.agents.runtime import _server_tool_events, run_agent_turn
from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    Message,
    ServerToolChunk,
    TextChunk,
    Usage,
)


class Searching:
    """A provider that searched for itself, the way DeepSeek's does."""

    kind = "fake"

    def __init__(self):
        self.requests: list[ChatRequest] = []

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        self.requests.append(req)
        yield TextChunk("Python 3.14 is the latest stable release.")
        yield ServerToolChunk(
            call_id="call_00_abc",
            name="web_search",
            query="latest stable Python version",
            results=6,
        )
        yield DoneChunk("stop", Usage(120, 40))

    async def aclose(self):
        return None


async def drain(provider) -> list[dict]:
    budget = BudgetTracker(
        BudgetLimits(max_llm_calls=5, max_supersteps=5, max_tokens=10**6, timeout_sec=60)
    )
    return [
        item
        async for item in run_agent_turn(
            provider=provider,
            caps=Capabilities(tool_calling=True),
            request=ChatRequest(
                model="m1", messages=[Message("user", "what is new")], max_tokens=500
            ),
            mission_id="m-1",
            agent_id="a-1",
            budget=budget,
        )
        if item.get("channel") != "ephemeral"
    ]


async def test_a_provider_run_search_reaches_the_timeline():
    # A run where the agent read the internet and the record does not say so is
    # a record missing the most important thing that happened.
    events = await drain(Searching())
    starts = [e for e in events if e["type"] == "agent.tool.start"]
    ends = [e for e in events if e["type"] == "agent.tool.end"]

    assert len(starts) == 1 and len(ends) == 1
    assert starts[0]["payload"]["tool"] == "web_search"
    assert starts[0]["payload"]["input"]["query"] == "latest stable Python version"


async def test_it_is_marked_as_the_provider_s_doing():
    events = await drain(Searching())
    for event in events:
        if event["type"] in {"agent.tool.start", "agent.tool.end"}:
            # Not "client". This app never saw the call, could not have shown a
            # modal, and did not redact the input (§16.8).
            assert event["payload"]["origin"] == "provider"


async def test_the_end_says_what_could_not_be_seen():
    events = await drain(Searching())
    end = next(e for e in events if e["type"] == "agent.tool.end")
    summary = end["payload"]["summary"]
    # The results are `encrypted_content` on this endpoint. Saying "6 results"
    # and stopping there would imply we know what they said.
    assert "not visible to this app" in summary
    assert "6 result" in summary


async def test_a_client_tool_call_says_client():
    # The other half of the same assertion: the two origins have to be
    # distinguishable, or the field says nothing.
    from pathlib import Path
    from tempfile import TemporaryDirectory

    from agentd.providers.base import ToolCallChunk
    from agentd.tools import registry
    from agentd.tools.base import ToolContext
    from agentd.tools.execution import ToolBox

    class Calling(Searching):
        async def stream(self, req, caps):
            self.requests.append(req)
            if len(self.requests) == 1:
                yield ToolCallChunk("c1", "list_dir", "{}")
            else:
                yield TextChunk("done")
            yield DoneChunk("stop", Usage(10, 5))

    with TemporaryDirectory() as folder:
        Path(folder, "a.txt").write_text("x", encoding="utf-8")
        box = ToolBox(
            specs=[registry.get("list_dir")],
            context=ToolContext(mission_id="m-1", agent_id="a-1", workspace_root=folder),
            autonomy="trusted",
        )
        budget = BudgetTracker(
            BudgetLimits(max_llm_calls=5, max_supersteps=5, max_tokens=10**6, timeout_sec=60)
        )
        events = [
            item
            async for item in run_agent_turn(
                provider=Calling(),
                caps=Capabilities(tool_calling=True),
                request=ChatRequest(
                    model="m1", messages=[Message("user", "look")], max_tokens=500
                ),
                mission_id="m-1",
                agent_id="a-1",
                budget=budget,
                tools=box,
            )
            if item.get("channel") != "ephemeral"
        ]

    start = next(e for e in events if e["type"] == "agent.tool.start")
    assert start["payload"]["origin"] == "client"


def test_the_pair_is_built_from_the_report_and_nothing_else():
    # There is no duration to report: the search happened inside a completion
    # this app was waiting on, so any number here would be invented.
    start, end = _server_tool_events(
        "a-1", ServerToolChunk(call_id="c", name="web_search", query="q", results=0)
    )
    assert end["payload"]["durationMs"] == 0
    assert end["payload"]["ok"] is True
    assert start["payload"]["callId"] == end["payload"]["callId"] == "c"


def test_the_flag_is_off_unless_a_profile_turns_it_on():
    from agentd.providers.anthropic_provider import AnthropicProvider

    provider = AnthropicProvider(api_key="k", base_url="https://api.deepseek.com/anthropic")
    # Off by default: turning this on removes the approval gate for one tool,
    # and nobody should get that by upgrading (§16.8).
    assert provider._native_search is False

    with_search = AnthropicProvider(api_key="k", native_search=True)
    assert with_search._native_search is True


@pytest.mark.parametrize(
    ("base_url", "allowed"),
    [
        ("https://api.deepseek.com/anthropic", True),
        ("https://api.deepseek.com/v1", False),
        ("https://api.anthropic.com", False),
        (None, False),
        ("https://api.deepseek.com.evil.net/anthropic", False),
    ],
)
def test_only_a_known_endpoint_may_offer_it(base_url: str | None, allowed: bool):
    from agentd.providers.native_search import supports_native_search

    # Confirmed by reading the docs and then by sending the request: it is this
    # endpoint, on this path. Anywhere else the flag would be a setting that
    # does nothing, which is worse than not offering it.
    assert supports_native_search(base_url) is allowed
