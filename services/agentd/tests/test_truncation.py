"""Truncation must never be mistaken for a capability (§3.1).

This file exists because of a real false negative. The structured-output probe
ran with `max_tokens=128`; DeepSeek spent 137 tokens reasoning before its first
visible character, the reply was cut off at `{"ok": true, "` and `json.loads`
raised "Unterminated string". The model was recorded as unable to produce JSON.
It could — at a higher cap it answered `{"ok": true, "note": "Ready"}` in 166
output tokens.

The same shape of bug is waiting in M4: tool-call arguments also arrive as
streamed fragments, and today's probe only passes because the calls are short.
The long-arguments tests below are the guard for that.
"""

from __future__ import annotations

import json

import pytest

from agentd.agents.runtime import run_agent_turn
from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    Message,
    ProviderError,
    TextChunk,
    ToolCallChunk,
    Usage,
    was_truncated,
)
from agentd.providers.openai_compatible import OpenAICompatibleProvider
from agentd.providers.probe import PROBE_MAX_TOKENS, run_probe


def test_truncated_stop_reasons_cover_both_vendors_spellings():
    assert was_truncated("length")      # OpenAI-compatible
    assert was_truncated("max_tokens")  # Anthropic
    assert not was_truncated("stop")
    assert not was_truncated("end_turn")
    assert not was_truncated(None)


# ---- the probe ---------------------------------------------------------


class StreamProvider:
    """Replays a scripted stream, optionally cut off at max_tokens."""

    kind = "fake"

    def __init__(self, *, text="ready", stop="stop", tool=None, fail_modes=()):
        self._text = text
        self._stop = stop
        self._tool = tool
        self._fail_modes = set(fail_modes)

    async def list_models(self):
        return ["m1"]

    async def stream(self, req: ChatRequest, caps: Capabilities):
        if req.response_schema and caps.structured_output in self._fail_modes:
            raise ProviderError("provider_400", "This response_format type is unavailable now")
        if req.tools and self._tool is not None:
            yield self._tool
        elif req.response_schema:
            yield TextChunk(self._text)
        else:
            yield TextChunk("ready")
        yield DoneChunk(self._stop, Usage(10, 20))

    async def aclose(self):
        return None


def check(result, cid):
    return next(c for c in result.checks if c.id == cid)


async def test_a_truncated_json_reply_is_inconclusive_not_a_capability():
    """The exact regression: a cut-off reply proves nothing about the model."""
    provider = StreamProvider(text='{"ok": true, "', stop="length")
    result = await run_probe(provider, "m1")

    structured = check(result, "structured")
    assert structured.status == "inconclusive"
    assert "cut off" in structured.detail
    # And therefore it must not reach the database.
    assert "structured_output" not in result.conclusive
    assert "structured_output" not in result.conclusive_capabilities()


async def test_an_explicit_rejection_is_conclusive():
    """A 400 saying the mode is unavailable is a real answer about the endpoint,
    unlike a truncation — so it is recorded."""
    provider = StreamProvider(text='{"ok": true, "note": "hi"}', fail_modes={"schema"})
    result = await run_probe(provider, "m1")

    structured = check(result, "structured")
    assert structured.status == "pass"
    assert result.capabilities.structured_output == "json_object"
    assert "structured_output" in result.conclusive


async def test_both_modes_rejected_records_none():
    provider = StreamProvider(fail_modes={"schema", "json_object"})
    result = await run_probe(provider, "m1")
    assert check(result, "structured").status == "fail"
    assert result.capabilities.structured_output == "none"
    assert "structured_output" in result.conclusive  # a real observation


async def test_a_truncated_tool_call_is_inconclusive():
    """M4's version of the same bug: half-written arguments are not evidence
    that the model cannot call tools."""
    provider = StreamProvider(
        tool=ToolCallChunk("c1", "report_status", '{"status": "fi', truncated=True),
        stop="length",
    )
    result = await run_probe(provider, "m1")

    tools = check(result, "tools")
    assert tools.status == "inconclusive"
    assert "tool_calling" not in result.conclusive


async def test_the_probe_leaves_room_for_reasoning_tokens():
    """A cap tight enough to cut off a reasoning model turns every probe into a
    false negative. 128 was; the observed reply needed 166 output tokens."""
    assert PROBE_MAX_TOKENS >= 1024


async def test_an_empty_reply_fails_chat_rather_than_passing_silently():
    provider = StreamProvider(text="")

    class Silent(StreamProvider):
        async def stream(self, req, caps):
            yield DoneChunk("stop", Usage(5, 0))

    result = await run_probe(Silent(), "m1")
    assert check(result, "chat").status == "fail"
    assert not result.ok
    del provider


async def test_counts_are_reported_so_the_ui_can_be_accurate():
    """The UI showed "All checks passed" while one had failed. Reproduces the
    real shape: models, chat and tools pass, structured output does not."""
    provider = StreamProvider(
        tool=ToolCallChunk("c1", "report_status", '{"status": "fine"}'),
        fail_modes={"schema", "json_object"},
    )
    result = await run_probe(provider, "m1")

    counts = result.counts
    assert counts == {"passed": 3, "failed": 1, "inconclusive": 0, "total": 4}
    # ok stays true: chat works, so the endpoint is usable — which is exactly
    # why the badge could not be driven off `ok` alone.
    assert result.ok


# ---- the provider layer ------------------------------------------------


class FakeStream:
    """Minimal stand-in for an OpenAI-compatible streaming response."""

    def __init__(self, events):
        self._events = events

    def __aiter__(self):
        async def gen():
            for e in self._events:
                yield e

        return gen()


def _delta(content=None, tool=None, finish=None):
    class Fn:
        name = tool[0] if tool else None
        arguments = tool[1] if tool else None

    class TC:
        index = 0
        id = "call_1"
        function = Fn()

    class Delta:
        pass

    d = Delta()
    d.content = content
    d.tool_calls = [TC()] if tool else []

    class Choice:
        delta = d
        finish_reason = finish

    class Event:
        choices = [Choice()]
        usage = None

    return Event()


async def test_long_tool_arguments_cut_off_are_flagged_not_handed_on(monkeypatch):
    """Arguments arrive in fragments. Today's probe passes only because the
    calls are short; a long one that hits the cap yields invalid JSON that
    would otherwise be executed as if the model had asked for it."""
    long_args = json.dumps({"query": "x" * 4000})
    fragments = [long_args[i : i + 40] for i in range(0, len(long_args), 40)]
    # Cut off partway: the last fragments never arrive.
    delivered = fragments[: len(fragments) // 2]

    events = [_delta(tool=("search", frag)) for frag in delivered]
    events.append(_delta(finish="length"))

    provider = OpenAICompatibleProvider(api_key="k", base_url="http://localhost:1")

    async def fake_create(**_kwargs):
        return FakeStream(events)

    monkeypatch.setattr(provider._client.chat.completions, "create", fake_create)

    calls = [
        c
        async for c in provider.stream(
            ChatRequest(model="m", messages=[Message("user", "hi")], max_tokens=10),
            Capabilities(tool_calling=True),
        )
        if isinstance(c, ToolCallChunk)
    ]

    assert len(calls) == 1
    assert calls[0].truncated is True
    with pytest.raises(json.JSONDecodeError):
        json.loads(calls[0].arguments_json)  # genuinely unusable


async def test_complete_tool_arguments_are_not_flagged(monkeypatch):
    args = json.dumps({"query": "hello"})
    events = [_delta(tool=("search", frag)) for frag in (args[:5], args[5:])]
    events.append(_delta(finish="tool_calls"))

    provider = OpenAICompatibleProvider(api_key="k", base_url="http://localhost:1")

    async def fake_create(**_kwargs):
        return FakeStream(events)

    monkeypatch.setattr(provider._client.chat.completions, "create", fake_create)

    calls = [
        c
        async for c in provider.stream(
            ChatRequest(model="m", messages=[Message("user", "hi")], max_tokens=100),
            Capabilities(tool_calling=True),
        )
        if isinstance(c, ToolCallChunk)
    ]
    assert len(calls) == 1
    assert calls[0].truncated is False
    assert json.loads(calls[0].arguments_json) == {"query": "hello"}


# ---- the runtime -------------------------------------------------------


class ToolProvider:
    kind = "fake"

    def __init__(self, chunk):
        self._chunk = chunk

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        yield self._chunk
        yield DoneChunk("length", Usage(1, 1))

    async def aclose(self):
        return None


async def test_runtime_refuses_to_treat_a_truncated_call_as_complete():
    provider = ToolProvider(
        ToolCallChunk("c1", "search", '{"query": "unfinis', truncated=True)
    )
    items = [
        item
        async for item in run_agent_turn(
            provider=provider,
            caps=Capabilities(tool_calling=True),
            request=ChatRequest(
                model="m1", messages=[Message("user", "hi")], max_tokens=50
            ),
            mission_id="m-1",
            agent_id="a1",
            budget=BudgetTracker(
                BudgetLimits(
                    max_llm_calls=10, max_supersteps=10, max_tokens=1000, timeout_sec=60
                )
            ),
        )
    ]
    codes = [i["payload"]["code"] for i in items if i.get("type") == "error"]
    assert "tool_call_truncated" in codes
    assert "unexpected_tool_call" not in codes  # not the same problem
