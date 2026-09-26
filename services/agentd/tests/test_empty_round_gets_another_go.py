"""A reply that came back completely empty buys one more attempt.

From `PARADOX.ART`, twice in one run, identically:

    seq 74  Basil  agent.message   0 chars, outputTokens = 16384
    seq 76  error  output_truncated
    seq 77  mission.progress  "Build index.html and css/brutal.css" -> failed

No text and no tool call: the whole per-reply budget went on reasoning about a
728-line spec. Nothing else was short — the mission had **1.2 million tokens
left** and had used **2 of its 24 tool rounds** — and the turn ended anyway,
throwing away the conversation that already held the contract.

The planner met this wall first and the answer is already in the file:
`TOKENS_PER_RETRY` buys more room, and only for a truncated attempt, because a
reply rejected for any other reason does not need a bigger budget to fix it.
The work turn had one attempt and no escalation at all. This is that
escalation — plus a sentence, because a second attempt handed nothing but more
room is the first attempt again.
"""

from __future__ import annotations

from agentd.agents.runtime import (
    EMPTY_ROUND_RETRIES,
    NOTHING_CAME_BACK,
    TOKENS_PER_EMPTY_ROUND,
    run_agent_turn,
)
from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    Message,
    TextChunk,
    Usage,
)

CAP = 16384


class Model:
    """Replies as the script says, and records what it was asked each time."""

    kind = "fake"

    def __init__(self, *replies: tuple[str, str]) -> None:
        self._replies = list(replies)
        self.rooms: list[int] = []
        self.prompts: list[list[str]] = []

    async def list_models(self):
        return ["m1"]

    async def stream(self, request, caps):
        self.rooms.append(request.max_tokens)
        self.prompts.append([m.content for m in request.messages])
        text, stop = self._replies[min(len(self.rooms) - 1, len(self._replies) - 1)]
        if text:
            yield TextChunk(text)
        yield DoneChunk(stop, Usage(10, CAP if stop == "length" else 20))

    async def aclose(self):
        return None


async def drain(model: Model) -> list[dict]:
    budget = BudgetTracker(
        BudgetLimits(
            max_llm_calls=50, max_supersteps=50, max_tokens=10**6, timeout_sec=300
        )
    )
    return [
        item
        async for item in run_agent_turn(
            provider=model,
            caps=Capabilities(),
            request=ChatRequest(
                model="m1",
                messages=[Message("user", "Build index.html.")],
                max_tokens=CAP,
            ),
            budget=budget,
            agent_id="a-1",
            mission_id="m-1",
        )
    ]


def codes(items: list[dict]) -> list[str]:
    return [i["payload"]["code"] for i in items if i["type"] == "error"]


def texts(items: list[dict]) -> list[str]:
    return [
        i["payload"]["content"]
        for i in items
        if i["type"] == "agent.message"
    ]


async def test_an_empty_cut_off_reply_is_tried_again_with_more_room():
    model = Model(("", "length"), ("Wrote index.html.", "stop"))
    items = await drain(model)

    assert len(model.rooms) == 2, "the turn ended instead of trying again"
    assert model.rooms[0] == CAP
    assert model.rooms[1] == CAP + TOKENS_PER_EMPTY_ROUND
    # And it recovered: the answer from the second attempt is what the task
    # gets, rather than a failure over a mission with everything left.
    assert texts(items)[-1] == "Wrote index.html."


async def test_the_model_is_told_why_rather_than_just_given_more():
    model = Model(("", "length"), ("Wrote index.html.", "stop"))
    await drain(model)

    second = model.prompts[1]
    assert NOTHING_CAME_BACK in second
    assert "Build index.html." in second, "its own task must still be there"


async def test_a_reply_that_said_something_is_not_retried():
    # The existing rule is untouched: a reply cut off *mid-sentence* has said
    # something, and is reported truncated rather than bought a second go.
    model = Model(("Here is what I am about to write:", "length"))
    await drain(model)

    assert len(model.rooms) == 1
    assert "output_truncated" in codes(await drain(Model(
        ("Here is what I am about to write:", "length"))))


async def test_a_clean_empty_reply_is_not_retried():
    # Empty but *not* truncated is a model that had nothing to say, which more
    # room cannot help.
    model = Model(("", "stop"))
    await drain(model)
    assert len(model.rooms) == 1


async def test_it_pays_for_this_once():
    model = Model(("", "length"), ("", "length"), ("", "length"))
    await drain(model)

    assert len(model.rooms) == 1 + EMPTY_ROUND_RETRIES, (
        "a second empty reply is the model doing the same thing again; paying "
        "a third time is how one turn quietly costs four times what it should"
    )
    # And the turn still ends honestly rather than looking like a success.
    items = await drain(Model(("", "length"), ("", "length")))
    assert "output_truncated" in codes(items)
