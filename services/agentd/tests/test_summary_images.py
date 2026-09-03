"""The summariser sees what the run was about (§1, §12 M9.3).

Found on a live run against a vision model. The worker read the attached image
and reported `purple, yellow, teal, orange` — correct, and visible on the
timeline. The leader then wrote the run's final answer without the image, and
because the goal said "look at the image", it answered **"I cannot see the
image."**

That sentence became `mission.ended`'s summary and the text of
`final-answer.md`. So a run that answered correctly was recorded as having
failed, which is the one thing §1 forbids: the record contradicting what
happened. The comment above `images` claimed they were "handed to every agent's
turn"; only the work turn ever got them.
"""

from __future__ import annotations

import pytest

from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.orchestrator.graph import run_team_mission
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    ImagePart,
    TextChunk,
    Usage,
)
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

pytestmark = pytest.mark.anyio

PNG = ImagePart(media_type="image/png", data_b64="aGVsbG8=")


def member(seat, agent_id, name, *, leader=False):
    return SnapshotMember(
        agent_id=agent_id,
        name=name,
        seat_index=seat,
        role_in_team="leader" if leader else "member",
        system_prompt=f"You are {name}.",
        provider_id="prov-1",
        model="m1",
        sampling=None,
        tools=[],
        avatar_config={"body": "slim"},
    )


class Recorder:
    """Answers everything, and remembers which turns carried a picture."""

    def __init__(self):
        #: (first 40 chars of the instruction, how many images it carried)
        self.turns: list[tuple[str, int]] = []

    async def stream(self, req: ChatRequest, caps: Capabilities):
        last = req.messages[-1]
        text = last.content or ""
        self.turns.append((text, len(last.images or ())))
        # A planning request is the one carrying a response_schema.
        if req.response_schema:
            yield TextChunk(
                '{"tasks": [{"id": "t1", "title": "Look", "assignee_seat": 1, "instruction": "Look at it"}]}'
            )
        else:
            yield TextChunk("purple, yellow, teal, orange")
        yield DoneChunk("stop", Usage(20, 30))

    async def aclose(self):
        return None


def budget() -> BudgetTracker:
    return BudgetTracker(
        BudgetLimits(
            max_llm_calls=50, max_supersteps=50, max_tokens=1_000_000, timeout_sec=300
        )
    )


async def run_with_images():
    model = Recorder()
    items = []
    async for item in run_team_mission(
        mission_id="m-1",
        snapshot=RosterSnapshot(
            [member(0, "a-lead", "Lead", leader=True), member(1, "a-one", "One")]
        ),
        goal="Look at the image and name the colours.",
        budget=budget(),
        provider_for=lambda _m: (model, Capabilities()),
        images=(PNG,),
    ):
        items.append(item)
    return model, items


async def test_the_turn_that_writes_the_final_answer_can_see_the_picture():
    model, _items = await run_with_images()

    summarising = [
        count
        for text, count in model.turns
        if "Your team reported" in text
    ]
    assert summarising, "no summary turn happened"
    assert all(count == 1 for count in summarising), (
        "the leader wrote the run's final answer without the image it is about"
    )

    # `mission.ended` is written by the runner, not the graph, so the check that
    # matters here is the one above: what the summarising turn was given.


async def test_the_work_turn_still_carries_it():
    model, _ = await run_with_images()
    work = [count for text, count in model.turns if "Look at it" in text]
    assert work and all(count == 1 for count in work)
