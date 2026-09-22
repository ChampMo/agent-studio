"""A continued round knows what the earlier ones did (§7, §12 M10).

Continuing a run reopens the same mission with the same frozen roster and
appends to the same log — but the planner was handed the new message and
nothing else. So "carry on" was a goal that read, in full, "carry on": the
leader could not see the original instruction, what the team had built, or the
handover it had itself written one event earlier.

The handover is the sharp part. It names every file, what is missing and what
to do first, it is produced on every round that runs out — and until now the
only thing that ever read it was a person.

Assembled from `mission_events` rather than kept anywhere. The log is the
record (§2.1), and a second place saying what a run achieved is a second place
to be wrong: a status file claiming the admin pages are done, when they were
never written, is worse than no file at all.
"""

from __future__ import annotations

import json

import pytest

from agentd.orchestrator.planner import make_plan
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

pytestmark = pytest.mark.anyio

PLAN = json.dumps(
    {"tasks": [{"id": "t1", "title": "Do it", "assignee_seat": 1, "instruction": "go"}]}
)


def roster() -> RosterSnapshot:
    def member(seat, name, leader=False):
        return SnapshotMember(
            agent_id=f"a-{seat}",
            name=name,
            seat_index=seat,
            role_in_team="leader" if leader else "member",
            system_prompt="s",
            provider_id="p",
            model="m",
            sampling=None,
            tools=["write_file"],
            avatar_config={"size": "normal"},
        )

    return RosterSnapshot([member(0, "Lead", True), member(1, "Worker")])


class Recorder:
    """Answers with a valid plan and keeps what it was asked."""

    kind = "openai_compatible"

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def stream(self, request, caps):
        self.prompts.append(request.messages[-1].content)
        yield TextChunk(PLAN)
        yield DoneChunk("stop", Usage(input_tokens=10, output_tokens=10))

    async def aclose(self):
        return None


async def plan(goal: str, earlier: str = "") -> Recorder:
    provider = Recorder()
    await make_plan(
        provider=provider,
        caps=Capabilities(structured_output="json_object"),
        model="m",
        snapshot=roster(),
        goal=goal,
        earlier=earlier,
    )
    return provider


async def test_a_first_round_is_asked_the_goal_and_nothing_else():
    # Nothing has happened yet, so there is nothing to carry, and inventing a
    # preamble would be paying for words that say nothing.
    provider = await plan("Build the thing.")
    assert provider.prompts[0] == "Goal: Build the thing."


async def test_a_continued_round_is_shown_what_came_before():
    provider = await plan(
        "carry on",
        earlier=(
            "You were asked: Build a storefront.\n\n"
            "That round ended (budget_exceeded).\n"
            "Handover: layout and landing page written; admin pages missing."
        ),
    )
    asked = provider.prompts[0]
    assert "Build a storefront." in asked
    assert "admin pages missing" in asked
    # And the new message is still there, as the thing being asked for now.
    assert "carry on" in asked


async def test_it_is_told_not_to_redo_finished_work():
    # Without this the obvious plan for "carry on" is the original plan again,
    # which is the most expensive possible answer.
    provider = await plan("carry on", earlier="You were asked: Build it.")
    assert "already finished" in provider.prompts[0]


async def test_it_is_told_not_to_assume_the_rest_was_finished():
    # The other direction, and the one that matters more: a handover says what
    # was *reported*, and a leader that reads "most files are created" as "the
    # job is done" plans nothing and the round achieves nothing.
    provider = await plan("carry on", earlier="You were asked: Build it.")
    assert "does not say was" in provider.prompts[0]
