"""One agent turn, as an async generator (PROJECT_BRIEF.md §4.1).

The whole design of this module is one rule: **it yields, it never publishes.**
No import of the bus, no `seq`, no `ts`, no `id`. The caller decides where each
item goes. That is what lets M4 wrap this in a LangGraph node without editing a
line of it — the node becomes the caller, and nothing else changes.

Two kinds of item come out, and the caller routes them differently (§7.1):

* a **sequenced draft** — `{"type", "payload"}` — goes to the bus, is persisted,
  and gets a `seq`;
* an **ephemeral frame** — carries `"channel": "ephemeral"` — is broadcast
  straight to sockets, is never stored, and never consumes a `seq`.

Cancellation is the caller closing this generator. There is no cancel flag to
check, which means no code path can forget to check it.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

from ..core.budget import BudgetTracker
from ..providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    LLMProvider,
    NoticeChunk,
    ProviderError,
    TextChunk,
    ToolCallChunk,
)
from ..providers.pricing import cost_usd


def is_ephemeral(item: dict[str, Any]) -> bool:
    """The routing test the caller uses. One place, so it cannot drift."""
    return item.get("channel") == "ephemeral"


def _draft(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": event_type, "payload": payload}


def _delta(
    mission_id: str, agent_id: str, message_id: str, index: int, text: str
) -> dict[str, Any]:
    return {
        "channel": "ephemeral",
        "type": "agent.message.delta",
        "missionId": mission_id,
        "agentId": agent_id,
        "messageId": message_id,
        "index": index,
        "text": text,
    }


async def run_agent_turn(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    request: ChatRequest,
    mission_id: str,
    agent_id: str,
    budget: BudgetTracker,
) -> AsyncIterator[dict[str, Any]]:
    """Stream one reply, narrating it as events.

    Raises `BudgetExceeded` or `ProviderError` — the caller turns those into the
    right `mission.ended` reason, because only the caller knows the mission.
    """
    # Before anything is spent: a limit already reached must stop the turn
    # rather than start a call it cannot pay for.
    budget.check()

    message_id = str(uuid.uuid4())
    yield _draft("agent.status", {"agentId": agent_id, "status": "thinking"})

    # The real ceiling. Output tokens are unknown until the stream ends, so a
    # check afterwards could only report the overrun (§10.1).
    request = ChatRequest(
        model=request.model,
        messages=request.messages,
        max_tokens=budget.clamp_max_tokens(request.max_tokens),
        system=request.system,
        tools=request.tools,
        sampling=request.sampling,
        response_schema=request.response_schema,
    )

    parts: list[str] = []
    index = 0
    done: DoneChunk | None = None
    status_switched = False

    # aclosing() so that cancelling this generator also finalises the provider's
    # stream. Without it the HTTP connection is left dangling until GC.
    async with aclosing(provider.stream(request, caps)) as stream:
        async for chunk in stream:
            if isinstance(chunk, TextChunk):
                if not status_switched:
                    yield _draft(
                        "agent.status", {"agentId": agent_id, "status": "working"}
                    )
                    status_switched = True
                parts.append(chunk.text)
                yield _delta(mission_id, agent_id, message_id, index, chunk.text)
                index += 1

            elif isinstance(chunk, NoticeChunk):
                # Something the agent was configured with could not be honoured.
                # Surfaced as a real event: a silently dropped setting would
                # make the timeline describe a run that never happened (§1).
                yield _draft(
                    "error",
                    {
                        "agentId": agent_id,
                        "code": chunk.code,
                        "message": chunk.message,
                        "recoverable": chunk.recoverable,
                    },
                )

            elif isinstance(chunk, ToolCallChunk):
                # M1 sends no tools, so this means the endpoint invented one.
                # Reported rather than dropped, for the same reason as above.
                yield _draft(
                    "error",
                    {
                        "agentId": agent_id,
                        "code": "unexpected_tool_call",
                        "message": f"model called {chunk.name!r} but no tools were offered",
                        "recoverable": True,
                    },
                )

            elif isinstance(chunk, DoneChunk):
                done = chunk

    usage = done.usage if done else None
    warnings = budget.record_call(usage.to_event_usage() if usage else None)

    yield _draft(
        "agent.message",
        {
            "agentId": agent_id,
            "messageId": message_id,
            "to": {"kind": "user"},
            "content": "".join(parts),
            **(
                {"usage": usage.to_event_usage(cost_usd(request.model, usage))}
                if usage
                else {}
            ),
        },
    )

    # After the message, so the timeline reads in the order things happened.
    for warning in warnings:
        yield warning

    yield _draft("agent.status", {"agentId": agent_id, "status": "idle"})

    # A refusal or a truncated reply is not an exception, and the run should not
    # look clean when it was not.
    if done and done.stop_reason in {"max_tokens", "length"}:
        yield _draft(
            "error",
            {
                "agentId": agent_id,
                "code": "output_truncated",
                "message": "the reply hit max_tokens and was cut off",
                "recoverable": True,
            },
        )


__all__ = ["run_agent_turn", "is_ephemeral", "ProviderError"]
