"""The app's own retry button produced a round that could not be planned.

A six-task round was stopped by the token limit with two tasks left over. The
person pressed "pick up what was not finished" — the app's own offer — and the
round died before doing anything:

    error [planning_failed] the leader could not produce a plan:
    tasks.0.instruction: String should have at most 2000 characters

Three separate things made that inevitable, and all three are covered here.

**The model was never told the limit.** It reaches a schema-capable endpoint
inside `Plan.model_json_schema()` and is dropped on a `json_object` one, which
is what this run used — so six of the first plan's seven instructions were over
a number nobody had given it.

**The rejection named an array index and no size.** `tasks.0.instruction` is a
vocabulary that appears nowhere else in the app, and "too long" with no number
is not something to edit towards.

**And the plan the model was asked to correct was handed back as `text[:2000]`
of ~11,000 characters** — one and a half of its own tasks, cut mid-string. So
"keep the others as they are" asked it to preserve text it could no longer see,
and it rewrote the whole plan from the goal on each attempt, overshooting every
time.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from agentd.orchestrator.planner import (
    MAX_INSTRUCTION_CHARS,
    Plan,
    PlanningFailed,
    _problem_from,
    make_plan,
)
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

pytestmark = pytest.mark.anyio


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


def plan_json(*lengths: int) -> str:
    return json.dumps(
        {
            "tasks": [
                {
                    "id": f"t{i + 1}",
                    "title": f"Task {i + 1}",
                    "assignee_seat": 1,
                    "instruction": "x" * n,
                }
                for i, n in enumerate(lengths)
            ]
        }
    )


class Provider:
    """Replies with each given plan in turn, and keeps every prompt it saw."""

    kind = "openai_compatible"

    def __init__(self, *replies: str):
        self.replies = list(replies)
        self.seen: list[list] = []
        self.systems: list[str] = []

    async def stream(self, request, caps):
        self.seen.append(list(request.messages))
        self.systems.append(request.system or "")
        reply = self.replies[min(len(self.seen) - 1, len(self.replies) - 1)]
        yield TextChunk(reply)
        yield DoneChunk("stop", Usage(input_tokens=100, output_tokens=200))

    async def aclose(self):
        return None


async def plan_with(provider: Provider):
    return await make_plan(
        provider=provider,
        caps=Capabilities(structured_output="json_object"),
        model="m",
        snapshot=roster(),
        goal="Build the thing.",
    )


async def test_the_limit_is_stated_to_the_model_not_only_enforced():
    provider = Provider(plan_json(10))
    await plan_with(provider)

    assert str(MAX_INSTRUCTION_CHARS) in provider.systems[0], (
        "a json_object endpoint never receives the schema, so a limit that is "
        "only in the schema is a limit the model is never given"
    )


async def test_a_rejected_plan_is_shown_back_whole():
    # Two tasks at the ceiling is ~4,000 characters of JSON. Clipped to 2,000
    # the model cannot see its own second task, which is exactly the one it is
    # being asked to leave alone.
    too_long = plan_json(MAX_INSTRUCTION_CHARS + 50, MAX_INSTRUCTION_CHARS - 50)
    provider = Provider(too_long, plan_json(10, 10))

    result = await plan_with(provider)

    assert result.attempts == 2
    echoed = [m.content for m in provider.seen[1] if m.role == "assistant"]
    assert echoed and echoed[0] == too_long, (
        "the model has to see the plan it is correcting; it used to be handed "
        f"the first 2000 of {len(too_long)} characters"
    )


async def test_the_rejection_names_the_task_and_the_overshoot():
    over = MAX_INSTRUCTION_CHARS + 137
    payload = json.loads(plan_json(over))
    payload["tasks"][0]["title"] = "Execute the edge-case test plan"
    with pytest.raises(ValidationError) as caught:
        Plan.model_validate(payload)

    problem = _problem_from(caught.value, payload)

    assert "t1" in problem and "Execute the edge-case test plan" in problem
    assert str(over) in problem and str(MAX_INSTRUCTION_CHARS) in problem
    assert "tasks.0.instruction" not in problem, "an array index is our vocabulary"
    # The point of showing the whole plan back is that this instruction is
    # obeyable. It was not, before.
    assert "every other task" in problem
    # The offending 2,137 characters are already in the reply above it.
    assert "x" * 200 not in problem


async def test_an_unrelated_validation_error_still_reads_plainly():
    payload = {"tasks": [{"id": "t1", "title": "T", "assignee_seat": 1}]}
    with pytest.raises(ValidationError) as caught:
        Plan.model_validate(payload)
    problem = _problem_from(caught.value, payload)
    assert "instruction" in problem


async def test_a_plan_that_never_fits_reports_every_attempt_and_its_cost():
    over = plan_json(MAX_INSTRUCTION_CHARS + 1)
    provider = Provider(over, over, over)

    with pytest.raises(PlanningFailed) as caught:
        await plan_with(provider)

    # Three attempts, all kept. The ending used to show only the last.
    assert len(caught.value.attempts) == 3
    # And the money they cost, which nothing read: the run recorded 0 tokens
    # over three calls to a reasoning model.
    assert caught.value.usage.input_tokens == 300
    assert caught.value.usage.output_tokens == 600
