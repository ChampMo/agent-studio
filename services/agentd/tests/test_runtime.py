"""M1 proof: the runtime yields, the caller publishes (PROJECT_BRIEF.md §4.1).

If these ever fail, M4 cannot wrap the runtime in a graph node without rewriting
it — which is the entire reason the boundary is drawn here.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from agentd.agents.runner import CHAT_AGENT_ID, MissionRunner
from agentd.agents.runtime import is_ephemeral, run_agent_turn
from agentd.core.budget import BudgetExceeded, BudgetLimits, BudgetTracker
from agentd.db.models import Mission
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    Message,
    NoticeChunk,
    ProviderError,
    TextChunk,
    Usage,
)


def limits(**kw) -> BudgetLimits:
    base = dict(max_llm_calls=10, max_supersteps=10, max_tokens=10_000, timeout_sec=60)
    return BudgetLimits(**{**base, **kw})


class ScriptedProvider:
    """Replays a fixed chunk list. Records whether its stream was closed."""

    kind = "fake"

    def __init__(self, chunks, *, hang: bool = False):
        self._chunks = chunks
        self._hang = hang
        self.closed = False
        self.stream_finalised = False
        self.last_max_tokens: int | None = None

    async def list_models(self):
        return ["m1"]

    async def stream(self, req: ChatRequest, caps: Capabilities):
        self.last_max_tokens = req.max_tokens
        try:
            for chunk in self._chunks:
                yield chunk
            if self._hang:
                await asyncio.Event().wait()  # never completes
        finally:
            self.stream_finalised = True

    async def aclose(self):
        self.closed = True


async def drain(provider, *, budget=None, request=None, caps=None):
    items = []
    async for item in run_agent_turn(
        provider=provider,
        caps=caps or Capabilities(),
        request=request
        or ChatRequest(model="m1", messages=[Message("user", "hi")], max_tokens=500),
        mission_id="m-1",
        agent_id="a1",
        budget=budget or BudgetTracker(limits()),
    ):
        items.append(item)
    return items


# ---- the yield-only contract -------------------------------------------


async def test_runtime_never_stamps_seq_ts_or_id():
    """Those three belong to the bus alone (§2.3). If the runtime set them, two
    agents running in parallel in M4 would collide."""
    items = await drain(
        ScriptedProvider([TextChunk("hello"), DoneChunk("end_turn", Usage(3, 4))])
    )
    for item in items:
        assert "seq" not in item
        assert "ts" not in item
        assert "id" not in item
    sequenced = [i for i in items if not is_ephemeral(i)]
    assert all(set(i) == {"type", "payload"} for i in sequenced)


async def test_text_becomes_ephemeral_deltas_plus_one_stored_message():
    items = await drain(
        ScriptedProvider(
            [TextChunk("he"), TextChunk("llo"), DoneChunk("end_turn", Usage(3, 4))]
        )
    )
    deltas = [i for i in items if is_ephemeral(i)]
    assert [d["text"] for d in deltas] == ["he", "llo"]
    assert [d["index"] for d in deltas] == [0, 1]
    # All deltas of one message share its id, so the UI can assemble them.
    assert len({d["messageId"] for d in deltas}) == 1

    messages = [i for i in items if i.get("type") == "agent.message"]
    assert len(messages) == 1
    assert messages[0]["payload"]["content"] == "hello"
    assert messages[0]["payload"]["messageId"] == deltas[0]["messageId"]


async def test_deltas_carry_no_seq_field_at_all():
    """Not merely unset — absent (§7.1)."""
    items = await drain(ScriptedProvider([TextChunk("x"), DoneChunk(None, Usage())]))
    for delta in (i for i in items if is_ephemeral(i)):
        assert "seq" not in delta
        assert delta["channel"] == "ephemeral"


async def test_status_goes_thinking_then_working_then_idle():
    items = await drain(
        ScriptedProvider([TextChunk("x"), DoneChunk("end_turn", Usage(1, 1))])
    )
    statuses = [
        i["payload"]["status"] for i in items if i.get("type") == "agent.status"
    ]
    assert statuses == ["thinking", "working", "idle"]


# ---- nothing is dropped silently ---------------------------------------


async def test_a_dropped_setting_becomes_a_visible_error_event():
    """The provider drops sampling a model will not accept; the runtime turns
    that into an event. Silence here would make the timeline describe a run
    that never happened (§1)."""
    items = await drain(
        ScriptedProvider(
            [
                NoticeChunk("sampling_dropped", "dropped temperature", True),
                TextChunk("ok"),
                DoneChunk("end_turn", Usage(1, 1)),
            ]
        )
    )
    errors = [i for i in items if i.get("type") == "error"]
    assert len(errors) == 1
    assert errors[0]["payload"]["code"] == "sampling_dropped"
    assert errors[0]["payload"]["recoverable"] is True


async def test_a_truncated_reply_is_reported():
    items = await drain(
        ScriptedProvider([TextChunk("cut"), DoneChunk("max_tokens", Usage(1, 500))])
    )
    codes = [i["payload"]["code"] for i in items if i.get("type") == "error"]
    assert "output_truncated" in codes


# ---- budget ------------------------------------------------------------


async def test_max_tokens_is_clamped_to_the_remaining_budget():
    """The clamp is the real ceiling: output tokens are unknown until the
    stream ends, so nothing checked afterwards could have prevented this."""
    budget = BudgetTracker(limits(max_tokens=100))
    provider = ScriptedProvider([TextChunk("x"), DoneChunk("end_turn", Usage(1, 1))])
    await drain(provider, budget=budget)
    assert provider.last_max_tokens == 100


async def test_a_spent_budget_stops_the_turn_before_any_call():
    budget = BudgetTracker(limits(max_tokens=10))
    budget.record_call({"inputTokens": 6, "outputTokens": 6})
    provider = ScriptedProvider([TextChunk("x"), DoneChunk(None, Usage())])
    with pytest.raises(BudgetExceeded):
        await drain(provider, budget=budget)
    assert provider.last_max_tokens is None  # never reached the provider


async def test_usage_reaches_the_message_and_the_budget():
    budget = BudgetTracker(limits())
    items = await drain(
        ScriptedProvider(
            [TextChunk("x"), DoneChunk("end_turn", Usage(100, 20, 5, 7))]
        ),
        budget=budget,
    )
    usage = next(i for i in items if i.get("type") == "agent.message")["payload"]["usage"]
    assert usage["inputTokens"] == 100
    assert usage["cacheReadTokens"] == 5
    assert usage["cacheWriteTokens"] == 7
    assert budget.tokens_used == 132
    # Unknown model, so no fabricated price (§6.2).
    assert "costUsd" not in usage


# ---- cancellation ------------------------------------------------------


async def test_closing_the_generator_finalises_the_provider_stream():
    """Cancel is the caller closing this generator. No flag to poll means no
    code path can forget to poll it — but the provider's stream must still be
    shut down, or the HTTP connection dangles."""
    provider = ScriptedProvider([TextChunk("a"), TextChunk("b")], hang=True)
    agen = run_agent_turn(
        provider=provider,
        caps=Capabilities(),
        request=ChatRequest(model="m1", messages=[Message("user", "hi")], max_tokens=50),
        mission_id="m-1",
        agent_id="a1",
        budget=BudgetTracker(limits()),
    )
    # Advance until the turn is genuinely inside the provider stream. Closing
    # before that would prove nothing: the stream would never have started.
    while True:
        item = await agen.__anext__()
        if is_ephemeral(item):
            break
    assert provider.stream_finalised is False

    await agen.aclose()
    assert provider.stream_finalised is True


# ---- the runner: mission lifecycle -------------------------------------


class StubProfile:
    id = "prov-1"
    kind = "fake"
    base_url = None
    model = "m1"
    capabilities = None


async def _runner_with(monkeypatch, db, bus, provider):
    from agentd.providers import registry

    monkeypatch.setattr(registry, "build_from_profile", lambda _p: provider)
    monkeypatch.setattr(registry, "capabilities_for", lambda _p: Capabilities())
    import agentd.agents.runner as runner_mod

    monkeypatch.setattr(runner_mod.registry, "build_from_profile", lambda _p: provider)
    monkeypatch.setattr(runner_mod.registry, "capabilities_for", lambda _p: Capabilities())
    return MissionRunner(db, bus)


async def test_chat_is_a_mission_and_ends_with_a_reason(monkeypatch, db, bus):
    """A chat gets the timeline, the budget and the stop button for free
    precisely because it is a mission (§15 row 4)."""
    provider = ScriptedProvider(
        [TextChunk("hi there"), DoneChunk("end_turn", Usage(5, 3))]
    )
    runner = await _runner_with(monkeypatch, db, bus, provider)

    mission_id = await runner.start_chat(profile=StubProfile(), content="hello")
    await runner.wait(mission_id)

    events = await bus.history(mission_id, 0, 999)
    types = [e["draft"]["type"] for e in events]
    assert types[0] == "mission.started"
    assert "user.message" in types  # the human's turn is on the record
    assert types[-1] == "mission.ended"
    assert events[-1]["draft"]["payload"]["reason"] == "completed"

    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one()
    assert mission.kind == "chat"
    assert mission.team_id is None
    assert mission.end_reason == "completed"
    # The roster snapshot exists from the very first mission (§5.1).
    assert mission.roster_snapshot[0]["agent_id"] == CHAT_AGENT_ID
    assert mission.roster_snapshot[0]["model"] == "m1"


async def test_cancel_ends_the_mission_with_reason_cancelled(monkeypatch, db, bus):
    provider = ScriptedProvider([TextChunk("start")], hang=True)
    runner = await _runner_with(monkeypatch, db, bus, provider)

    mission_id = await runner.start_chat(profile=StubProfile(), content="hello")
    for _ in range(100):  # let the turn reach the hanging stream
        await asyncio.sleep(0)
        if provider.last_max_tokens is not None:
            break

    assert await runner.cancel(mission_id) is True
    await runner.wait(mission_id)

    events = await bus.history(mission_id, 0, 999)
    ended = [e for e in events if e["draft"]["type"] == "mission.ended"]
    assert len(ended) == 1
    assert ended[0]["draft"]["payload"]["reason"] == "cancelled"
    assert provider.closed is True  # the provider client was shut down


async def test_a_provider_failure_ends_the_mission_as_failed(monkeypatch, db, bus):
    class Failing(ScriptedProvider):
        async def stream(self, req, caps):
            raise ProviderError("provider_auth", "API key rejected")
            yield  # pragma: no cover - makes this an async generator

    provider = Failing([])
    runner = await _runner_with(monkeypatch, db, bus, provider)
    mission_id = await runner.start_chat(profile=StubProfile(), content="hello")
    await runner.wait(mission_id)

    events = await bus.history(mission_id, 0, 999)
    codes = [
        e["draft"]["payload"]["code"] for e in events if e["draft"]["type"] == "error"
    ]
    assert "provider_auth" in codes
    assert events[-1]["draft"]["payload"]["reason"] == "failed"
