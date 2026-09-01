"""An agent that actually uses a tool (§16.1, §16.4, §12 M8).

The loop is the part of M8 that could be quietly wrong for a long time: a tool
that runs but whose result never reaches the model, an approval that is asked
for and then ignored, a file's contents copied into an append-only table. Each
of those is a test here, and each fails loudly if the wiring is undone.

The provider is a fake that asks for exactly the calls a test needs. That is the
whole point of the runtime being an async generator over a `LLMProvider`
protocol: this file needs no network, no key and no graph.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

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
from agentd.tools import registry
from agentd.tools.base import ToolContext
from agentd.tools.execution import ToolBox


class ScriptedModel:
    """Plays back a list of rounds. Records what it was sent each time."""

    kind = "fake"

    def __init__(self, rounds: list[list]):
        self._rounds = rounds
        self.seen: list[ChatRequest] = []

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        self.seen.append(req)
        chunks = self._rounds[min(len(self.seen) - 1, len(self._rounds) - 1)]
        for chunk in chunks:
            yield chunk
        yield DoneChunk("stop", Usage(10, 5))

    async def aclose(self):
        return None


class Gate:
    """Stands in for the runner: hands out futures and answers them."""

    def __init__(self, answer: str = "approve"):
        self.answer = answer
        self.opened: list[str] = []

    def open(self, mission_id: str, request_id: str):
        self.opened.append(request_id)
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        # Answered on the next turn of the loop, the way a person answering a
        # modal would: after the question has been published.
        asyncio.get_running_loop().call_soon(
            lambda: future.done() or future.set_result(self.answer)
        )
        return future


def toolbox(workspace: Path, *tool_ids: str, autonomy="ask_dangerous", gate=None) -> ToolBox:
    return ToolBox(
        specs=[registry.get(t) for t in tool_ids],
        context=ToolContext(
            mission_id="m-1", agent_id="a-1", workspace_root=str(workspace)
        ),
        autonomy=autonomy,
        gate=gate,
    )


def request() -> ChatRequest:
    return ChatRequest(model="m1", messages=[Message("user", "go")], max_tokens=1000)


async def drain(model, tools) -> list[dict]:
    budget = BudgetTracker(
        BudgetLimits(max_llm_calls=20, max_supersteps=20, max_tokens=10**6, timeout_sec=60)
    )
    return [
        item
        async for item in run_agent_turn(
            provider=model,
            caps=Capabilities(tool_calling=True),
            request=request(),
            mission_id="m-1",
            agent_id="a-1",
            budget=budget,
            tools=tools,
        )
        if item.get("channel") != "ephemeral"
    ]


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "notes.txt").write_text("first line\nsecond line\n", encoding="utf-8")
    return tmp_path


def types_of(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


def payload_of(events: list[dict], event_type: str) -> dict:
    for event in events:
        if event["type"] == event_type:
            return event["payload"]
    # Raised rather than StopIteration, which inside a coroutine surfaces as an
    # unrelated RuntimeError and hides which event was missing.
    raise AssertionError(f"no {event_type} in {types_of(events)}")


async def test_a_tool_result_reaches_the_model(workspace: Path):
    model = ScriptedModel(
        [
            [ToolCallChunk("c1", "read_file", '{"path": "notes.txt"}')],
            [TextChunk("The file says: first line.")],
        ]
    )
    events = await drain(model, toolbox(workspace, "read_file"))

    assert "agent.tool.start" in types_of(events)
    assert payload_of(events, "agent.tool.end")["ok"] is True

    # The second request carries the result. Without this the model is asked
    # again with no new information and loops until the round limit.
    second = model.seen[1]
    results = [m for m in second.messages if m.tool_results]
    assert results, "the tool result never went back to the model"
    assert "first line" in results[0].tool_results[0].content
    assert results[0].tool_results[0].call_id == "c1"

    # And the assistant message that asked for it is there too, in order — the
    # APIs reject a result that answers nothing.
    assert any(m.tool_calls for m in second.messages)


async def test_a_round_that_only_called_tools_publishes_no_empty_message(workspace: Path):
    model = ScriptedModel(
        [
            [ToolCallChunk("c1", "list_dir", "{}")],
            [TextChunk("Done.")],
        ]
    )
    events = await drain(model, toolbox(workspace, "list_dir"))
    messages = [e for e in events if e["type"] == "agent.message"]
    # One message, not two: an empty bubble would say the agent said nothing
    # when in fact it acted.
    assert len(messages) == 1
    assert messages[0]["payload"]["content"] == "Done."


async def test_a_file_written_by_a_tool_is_not_copied_onto_the_log(workspace: Path):
    """§12 M8 criterion 4, and the reason `redact_fields` exists."""
    secret = "an entire file's worth of content " * 50
    model = ScriptedModel(
        [
            [
                ToolCallChunk(
                    "c1",
                    "write_file",
                    json.dumps({"path": "out.md", "content": secret}),
                )
            ],
            [TextChunk("Written.")],
        ]
    )
    events = await drain(model, toolbox(workspace, "write_file"))

    start = payload_of(events, "agent.tool.start")
    assert start["input"]["path"] == "out.md"
    # The path stays, the content does not, and what replaces it says how much
    # there was — enough for a timeline to be true without being a copy.
    assert secret not in str(start)
    assert "bytes, not recorded" in start["input"]["content"]

    # It really did write the file.
    assert (workspace / "out.md").read_text(encoding="utf-8") == secret


async def test_a_dangerous_tool_asks_first_and_runs_when_approved(workspace: Path):
    gate = Gate(answer="approve")
    model = ScriptedModel(
        [
            [ToolCallChunk("c1", "write_file", '{"path": "new.txt", "content": "hi"}')],
            [TextChunk("Done.")],
        ]
    )
    # ask_always makes even a guarded tool stop, which is what that setting is
    # for; the same code path runs `bash` under ask_dangerous.
    events = await drain(
        model, toolbox(workspace, "write_file", autonomy="ask_always", gate=gate)
    )

    assert gate.opened, "no approval was asked for"
    question = payload_of(events, "agent.request")["question"]
    # The tool and its input, so the person is approving something they can see.
    assert "write_file" in question and "new.txt" in question
    assert payload_of(events, "agent.request")["kind"] == "approval"

    order = types_of(events)
    assert order.index("agent.request") < order.index("agent.tool.start")
    assert (workspace / "new.txt").read_text(encoding="utf-8") == "hi"


async def test_a_rejected_call_does_not_run_and_the_model_is_told(workspace: Path):
    gate = Gate(answer="reject")
    model = ScriptedModel(
        [
            [ToolCallChunk("c1", "write_file", '{"path": "new.txt", "content": "hi"}')],
            [TextChunk("Understood.")],
        ]
    )
    events = await drain(
        model, toolbox(workspace, "write_file", autonomy="ask_always", gate=gate)
    )

    assert "agent.tool.start" not in types_of(events)
    assert not (workspace / "new.txt").exists()
    assert payload_of(events, "agent.tool.end")["error"]["code"] == "not_approved"

    # Told as a result rather than as silence: the model can pick another route
    # instead of asking for the same thing again.
    outcome = [m for m in model.seen[1].messages if m.tool_results][0].tool_results[0]
    assert outcome.is_error is True
    assert "declined" in outcome.content


async def test_a_trusted_agent_is_not_asked(workspace: Path):
    gate = Gate()
    model = ScriptedModel(
        [
            [ToolCallChunk("c1", "write_file", '{"path": "new.txt", "content": "hi"}')],
            [TextChunk("Done.")],
        ]
    )
    events = await drain(
        model, toolbox(workspace, "write_file", autonomy="trusted", gate=gate)
    )
    assert gate.opened == []
    assert "agent.request" not in types_of(events)
    assert (workspace / "new.txt").exists()


async def test_a_truncated_call_is_never_executed(workspace: Path):
    model = ScriptedModel(
        [
            [
                ToolCallChunk(
                    "c1", "write_file", '{"path": "half.txt", "content": "unfin', truncated=True
                )
            ],
            [TextChunk("Sorry.")],
        ]
    )
    events = await drain(model, toolbox(workspace, "write_file", autonomy="trusted"))

    codes = [e["payload"].get("code") for e in events if e["type"] == "error"]
    assert "tool_call_truncated" in codes
    assert "agent.tool.start" not in types_of(events)
    assert not (workspace / "half.txt").exists()


async def test_a_tool_the_agent_does_not_have_is_refused(workspace: Path):
    model = ScriptedModel(
        [
            [ToolCallChunk("c1", "bash", '{"command": "rm -rf /"}')],
            [TextChunk("Fine.")],
        ]
    )
    events = await drain(model, toolbox(workspace, "read_file"))
    codes = [e["payload"].get("code") for e in events if e["type"] == "error"]
    assert "unknown_tool" in codes
    assert "agent.tool.start" not in types_of(events)


async def test_a_failing_tool_is_reported_and_the_model_carries_on(workspace: Path):
    model = ScriptedModel(
        [
            [ToolCallChunk("c1", "read_file", '{"path": "../outside.txt"}')],
            [TextChunk("I cannot reach that.")],
        ]
    )
    events = await drain(model, toolbox(workspace, "read_file"))

    end = payload_of(events, "agent.tool.end")
    assert end["ok"] is False
    assert end["error"]["code"] == "path_rejected"
    # The failure goes back as a result, so the turn continues rather than
    # ending on an error the model never saw.
    outcome = [m for m in model.seen[1].messages if m.tool_results][0].tool_results[0]
    assert outcome.is_error is True


async def test_a_model_that_never_stops_calling_tools_is_stopped(workspace: Path):
    forever = ScriptedModel([[ToolCallChunk("c1", "list_dir", "{}")]])
    events = await drain(forever, toolbox(workspace, "list_dir", autonomy="trusted"))

    codes = [e["payload"].get("code") for e in events if e["type"] == "error"]
    assert "tool_rounds_exhausted" in codes
    assert types_of(events)[-1] in {"agent.status", "error"}
