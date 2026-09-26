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

**Tools (M8).** A turn is a loop, not a single call: the model answers, may ask
for tools, and is called again with what they returned. Two things follow, and
both are visible in the code below.

*Approval happens here, not in the graph.* LangGraph re-runs an interrupted node
from the top (CLAUDE.md, M6), so pausing for approval above a completed LLM call
would pay for that call twice and publish its events twice. Instead the runtime
yields the `agent.request` — M6's event, M6's resolve endpoint, M6's modal — and
awaits an answer routed back by the runner. What that costs is honest and
recorded in §16.4: a tool approval does **not** survive the app closing, because
there is no checkpoint in the middle of a turn. The mission crashes and the tool
never ran, which is the safe direction to fail in.

*Nothing is looked up.* Which tools exist, where they may write and how much this
agent is trusted arrive in the `ToolBox`, resolved from the frozen snapshot
before the turn starts (§5.1).
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator, Mapping
from contextlib import aclosing
from typing import Any

from ..core.budget import BudgetTracker
from ..providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    LLMProvider,
    Message,
    NoticeChunk,
    ProviderError,
    ServerToolChunk,
    TextChunk,
    ToolCall,
    ToolCallChunk,
    ToolOutcome,
)
from ..providers.leaks import leaked_tool_call
from ..providers.pricing import cost_usd
from ..tools import execution
from ..tools.base import ToolFailed
from ..tools.execution import MAX_TOOL_ROUNDS, ToolBox


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


def _parse_arguments(raw: str) -> dict[str, Any] | None:
    """Tool arguments as an object, or None when they are not one.

    A string, a list or a syntax error are all the same problem from here: the
    call cannot be run, and the model has to be told rather than have something
    guessed on its behalf.
    """
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def run_agent_turn(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    request: ChatRequest,
    mission_id: str,
    agent_id: str,
    budget: BudgetTracker,
    tools: ToolBox | None = None,
    #: The most this one turn may spend, counted from where it started. None
    #: means the mission's own ceiling is the only one.
    #:
    #: Reaching it ends the turn the way running out of tool rounds does — an
    #: error on the log and whatever the agent has so far — rather than raising
    #: `BudgetExceeded`, which ends the *mission*. That difference is the whole
    #: point: one task overspending should cost that task, not the three tasks
    #: queued behind it.
    spend_ceiling: int | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Stream one reply — and any tool calls it leads to — narrating as events.

    Raises `BudgetExceeded` or `ProviderError` — the caller turns those into the
    right `mission.ended` reason, because only the caller knows the mission.
    """
    offered = tools.offered() if tools and tools.specs else None
    messages = list(request.messages)
    yield _draft("agent.status", {"agentId": agent_id, "status": "thinking"})

    final_done: DoneChunk | None = None

    spent_at_start = budget.tokens_used
    overspent = False

    for _round in range(MAX_TOOL_ROUNDS):
        # Before anything is spent: a limit already reached must stop the turn
        # rather than start a call it cannot pay for.
        budget.check()
        if (
            spend_ceiling is not None
            and budget.tokens_used - spent_at_start >= spend_ceiling
        ):
            overspent = True
            break

        message_id = str(uuid.uuid4())
        # The real ceiling. Output tokens are unknown until the stream ends, so
        # a check afterwards could only report the overrun (§10.1).
        call = ChatRequest(
            model=request.model,
            messages=messages,
            max_tokens=budget.clamp_max_tokens(request.max_tokens),
            system=request.system,
            tools=offered,
            sampling=request.sampling,
            response_schema=request.response_schema,
        )

        parts: list[str] = []
        index = 0
        done: DoneChunk | None = None
        status_switched = False
        calls: list[ToolCallChunk] = []

        # aclosing() so that cancelling this generator also finalises the
        # provider's stream. Without it the HTTP connection dangles until GC.
        async with aclosing(provider.stream(call, caps)) as stream:
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
                    # Something the agent was configured with could not be
                    # honoured. Surfaced as a real event: a silently dropped
                    # setting would make the timeline describe a run that never
                    # happened (§1).
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
                    calls.append(chunk)

                elif isinstance(chunk, ServerToolChunk):
                    # The endpoint searched the web during the completion and
                    # told us afterwards. Recorded, because a run where the
                    # agent read the internet and the timeline does not say so
                    # is a timeline that leaves out the most important thing
                    # that happened - and marked `provider`, because this app
                    # never saw the call, could not have refused it, and cannot
                    # read what came back (§16.8).
                    for item in _server_tool_events(agent_id, chunk):
                        yield item

                elif isinstance(chunk, DoneChunk):
                    done = chunk

        final_done = done
        usage = done.usage if done else None
        warnings = budget.record_call(usage.to_event_usage() if usage else None)

        text = "".join(parts)

        # A tool call the model wrote out as prose instead of calling. The
        # message is still published — it really did say it — but it is named
        # for what it is, so nobody reads a broken template as the agent's
        # answer and no round takes it as its summary (§1).
        if leaked_tool_call(text):
            yield _draft(
                "error",
                {
                    "agentId": agent_id,
                    "code": "tool_call_leaked",
                    "message": (
                        "the model wrote a tool call as text instead of calling "
                        "it, so nothing ran"
                    ),
                    "recoverable": True,
                },
            )

        if not (text or not calls) and usage is not None:
            # A round that only asked for tools publishes no message — see
            # below — and its cost used to go with it. The budget guard counted
            # those tokens either way, so a run stopped at 200,000 could show
            # 7,540 on its own timeline: the meter and the limit beside it were
            # not measuring the same thing (§1). Seen on a research run where
            # two `web_fetch` results, re-sent every turn, spent the whole
            # budget without a single token of it appearing on the log.
            yield _draft(
                "agent.usage",
                {
                    "agentId": agent_id,
                    "messageId": message_id,
                    "usage": usage.to_event_usage(cost_usd(call.model, usage)),
                },
            )

        if text or not calls:
            # A round that only asked for tools produces no message: an empty
            # bubble on the timeline would suggest the agent said nothing when
            # in fact it acted.
            yield _draft(
                "agent.message",
                {
                    "agentId": agent_id,
                    "messageId": message_id,
                    "to": {"kind": "user"},
                    "content": text,
                    **(
                        {"usage": usage.to_event_usage(cost_usd(call.model, usage))}
                        if usage
                        else {}
                    ),
                },
            )

        # After the message, so the timeline reads in the order things happened.
        for warning in warnings:
            yield warning

        if not calls:
            break

        # ---- the tools this round asked for --------------------------------
        made: list[ToolCall] = []
        outcomes: list[ToolOutcome] = []

        for requested in calls:
            async for item, outcome in _handle_call(
                requested,
                tools=tools,
                agent_id=agent_id,
                mission_id=mission_id,
                budget=budget,
            ):
                if item is not None:
                    yield item
                if outcome is not None:
                    made.append(
                        ToolCall(
                            call_id=requested.call_id,
                            name=requested.name,
                            arguments_json=requested.arguments_json,
                        )
                    )
                    outcomes.append(outcome)

        if not outcomes:
            # Nothing ran — every call was truncated, unknown or refused, and
            # each said so as an event. Continuing would re-ask the model with
            # no new information.
            break

        messages = [
            *messages,
            Message(role="assistant", content=text, tool_calls=tuple(made)),
            Message(role="tool", tool_results=tuple(outcomes)),
        ]
    else:
        yield _draft(
            "error",
            {
                "agentId": agent_id,
                "code": "tool_rounds_exhausted",
                # What happened, not a diagnosis of why. "The agent was not
                # converging on an answer" was a claim this code cannot
                # support and which the evidence contradicted: seven turns
                # stopped here on one run, every one of them working steadily
                # through shell checks the brief had asked for, all stopping at
                # exactly the limit. Reaching a ceiling is the only fact
                # available here (§1).
                "message": (
                    f"reached the limit of {MAX_TOOL_ROUNDS} rounds of tool "
                    "calls and was stopped with the task unfinished"
                ),
                "recoverable": True,
            },
        )

    if overspent:
        # Its own code, not `tool_rounds_exhausted`: running out of ideas and
        # running out of money need different answers from whoever reads this.
        yield _draft(
            "error",
            {
                "agentId": agent_id,
                "code": "task_budget_spent",
                "message": (
                    f"this task used its share of the run's budget "
                    f"({budget.tokens_used - spent_at_start:,} tokens) and was "
                    "stopped so the rest of the plan could still run"
                ),
                "recoverable": True,
            },
        )

    yield _draft("agent.status", {"agentId": agent_id, "status": "idle"})

    # A refusal or a truncated reply is not an exception, and the run should not
    # look clean when it was not.
    if final_done and final_done.stop_reason in {"max_tokens", "length"}:
        yield _draft(
            "error",
            {
                "agentId": agent_id,
                "code": "output_truncated",
                "message": "the reply hit max_tokens and was cut off",
                "recoverable": True,
            },
        )


def _server_tool_events(
    agent_id: str, chunk: ServerToolChunk
) -> list[dict[str, Any]]:
    """A search the provider ran, written down as the pair of events it was.

    Reconstructed rather than observed: there was no moment when this app could
    have shown a modal or redacted an input, so both events carry
    `origin: "provider"` and the end says what could not be seen.
    """
    return [
        _draft(
            "agent.tool.start",
            {
                "agentId": agent_id,
                "callId": chunk.call_id,
                "tool": chunk.name,
                "input": {"query": chunk.query},
                "origin": "provider",
            },
        ),
        _draft(
            "agent.tool.end",
            {
                "agentId": agent_id,
                "callId": chunk.call_id,
                "ok": True,
                "summary": (
                    f"the model's endpoint searched for {chunk.query!r} and used "
                    f"{chunk.results} result(s); the contents are not visible to "
                    "this app"
                ),
                "durationMs": 0,
                "origin": "provider",
            },
        ),
    ]


async def _handle_call(
    requested: ToolCallChunk,
    *,
    tools: ToolBox | None,
    agent_id: str,
    mission_id: str,
    #: Only so the clock can be held while a question is on screen. Nothing
    #: here spends any of it.
    budget: BudgetTracker,
) -> AsyncIterator[tuple[dict[str, Any] | None, ToolOutcome | None]]:
    """One tool call: check it, ask about it, run it, report it.

    Yields `(draft, outcome)` pairs — the draft goes to the caller's bus, and a
    non-null outcome is what goes back to the model. A call that is refused or
    unrunnable yields drafts and no outcome, so nothing false is fed back.
    """
    if requested.truncated:
        # Arguments arrive as streamed fragments, so a cut-off stream leaves
        # half-written JSON. Executing that would run a call the model never
        # finished asking for.
        yield (
            _draft(
                "error",
                {
                    "agentId": agent_id,
                    "code": "tool_call_truncated",
                    "message": (
                        f"call to {requested.name!r} was cut off at max_tokens "
                        "before its arguments finished; not executed"
                    ),
                    "recoverable": True,
                },
            ),
            None,
        )
        return

    spec = tools.get(requested.name) if tools else None
    if spec is None:
        yield (
            _draft(
                "error",
                {
                    "agentId": agent_id,
                    "code": "unknown_tool",
                    "message": (
                        f"model called {requested.name!r}, which this agent does not have"
                    ),
                    "recoverable": True,
                },
            ),
            None,
        )
        return

    assert tools is not None
    arguments = _parse_arguments(requested.arguments_json)
    if arguments is None:
        yield (
            _draft(
                "error",
                {
                    "agentId": agent_id,
                    "code": "bad_tool_arguments",
                    "message": f"arguments for {requested.name!r} were not a JSON object",
                    "recoverable": True,
                },
            ),
            None,
        )
        return

    safe_input = execution.redact_input(spec, arguments)

    # ---- ask, if this agent has to ask ------------------------------------
    if tools.gate is not None and await tools.needs_approval(spec):
        request_id = f"req-{uuid.uuid4()}"
        # Registered before the question is published: publishing first leaves a
        # window in which a fast answer arrives for a question nobody is waiting
        # on yet.
        waiting = tools.gate.open(mission_id, request_id)

        yield (
            _draft(
                "agent.request",
                {
                    "agentId": agent_id,
                    "requestId": request_id,
                    "kind": "approval",
                    # The tool and its input, redacted — approving something you
                    # cannot see is not approval (§16.4).
                    "question": _approval_question(spec.id, safe_input),
                    "options": [execution.APPROVE, "reject"],
                },
            ),
            None,
        )
        yield (_draft("agent.status", {"agentId": agent_id, "status": "waiting"}), None)

        # The clock stops here. Reading a command before approving it is the
        # whole point of the gate, and a mission timeout that counted that time
        # made the gate a reason runs died: 93% of one real build's 1,300
        # seconds was spent parked on questions like this one.
        with budget.paused_for_a_person():
            answer = await waiting
        if str(answer).strip().lower() != execution.APPROVE:
            yield (
                _draft(
                    "agent.tool.end",
                    {
                        "agentId": agent_id,
                        "callId": requested.call_id,
                        "ok": False,
                        "summary": f"{spec.id} was not approved",
                        "durationMs": 0,
                        "error": {
                            "code": "not_approved",
                            "message": "the user declined this tool call",
                        },
                    },
                ),
                None,
            )
            # Told to the model as a result rather than as silence, so it can
            # choose another route instead of asking again.
            yield (
                None,
                ToolOutcome(
                    call_id=requested.call_id,
                    name=spec.id,
                    content="The user declined this tool call. Do not retry it; choose another approach.",
                    is_error=True,
                ),
            )
            return
        yield (_draft("agent.status", {"agentId": agent_id, "status": "working"}), None)

    # ---- run it -----------------------------------------------------------
    yield (
        _draft(
            "agent.tool.start",
            {
                "agentId": agent_id,
                "callId": requested.call_id,
                "tool": spec.id,
                "input": safe_input,
                # Said explicitly rather than left to the absence of the other
                # value: this one passed the gate and was redacted (§16.1).
                "origin": "client",
            },
        ),
        None,
    )

    started = time.monotonic()
    try:
        result = await execution.run(spec, tools.context, arguments)
    except ToolFailed as failure:
        elapsed = int((time.monotonic() - started) * 1000)
        yield (
            _draft(
                "agent.tool.end",
                {
                    "agentId": agent_id,
                    "callId": requested.call_id,
                    "ok": False,
                    "summary": failure.message,
                    "durationMs": elapsed,
                    "error": {"code": failure.code, "message": failure.message},
                },
            ),
            None,
        )
        yield (
            None,
            ToolOutcome(
                call_id=requested.call_id,
                name=spec.id,
                content=f"{spec.id} failed: {failure.message}",
                is_error=True,
            ),
        )
        return

    elapsed = int((time.monotonic() - started) * 1000)
    yield (
        _draft(
            "agent.tool.end",
            {
                "agentId": agent_id,
                "callId": requested.call_id,
                "ok": True,
                "summary": result.summary,
                "durationMs": elapsed,
                **({"truncated": True} if result.truncated else {}),
            },
        ),
        None,
    )
    yield (
        None,
        ToolOutcome(
            call_id=requested.call_id, name=spec.id, content=result.content
        ),
    )


def _approval_question(tool_id: str, safe_input: dict[str, Any]) -> str:
    """What the modal shows. The tool, then its input, as it will run."""
    rendered = json.dumps(safe_input, indent=2, ensure_ascii=False, default=str)
    return f"Run {tool_id}?\n\n{rendered}"


__all__ = ["run_agent_turn", "is_ephemeral", "ProviderError"]
