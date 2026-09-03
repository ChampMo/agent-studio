"""A plan cut off mid-JSON gets more room, not a smaller plan (§7).

A five-agent team was given a detailed brief — three files, six behaviours, two
constraints — and failed all three planning attempts with *the plan was cut off
before the JSON closed*. The mission never started.

The correction cannot help. The tokens went on reasoning before the first
visible character, so "write each instruction much more briefly" is advice about
output the model never got to. It is the same wall `MAX_TOKENS_PER_TASK` hit
twice, where raising the cap once did not fix it either — and the thing that did
work both times was giving the model a way through rather than a smaller target.

Only truncation earns the extra room. A plan rejected for naming a seat nobody
occupies is not short of budget, and paying for a bigger one would be paying for
the wrong problem.
"""

from __future__ import annotations

import json

import pytest

from agentd.orchestrator.planner import (
    MAX_TOKENS,
    TOKENS_PER_RETRY,
    PlanningFailed,
    make_plan,
)
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

pytestmark = pytest.mark.anyio

GOOD = json.dumps(
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
            avatar_config={"body": "slim"},
        )

    return RosterSnapshot([member(0, "Lead", True), member(1, "Worker")])


class Provider:
    """Cut off for the first `cut` attempts, then answers."""

    kind = "openai_compatible"

    def __init__(self, cut: int, reply: str = GOOD):
        self.cut = cut
        self.reply = reply
        self.rooms: list[int] = []

    async def stream(self, request, caps):
        self.rooms.append(request.max_tokens)
        if len(self.rooms) <= self.cut:
            yield TextChunk('{"tasks": [{"id": "t1", "title": "Do')
            yield DoneChunk("length", Usage(input_tokens=10, output_tokens=10))
            return
        yield TextChunk(self.reply)
        yield DoneChunk("stop", Usage(input_tokens=10, output_tokens=10))

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


async def test_the_first_attempt_costs_what_it_always_did():
    provider = Provider(cut=0)
    await plan_with(provider)
    assert provider.rooms == [MAX_TOKENS]


async def test_being_cut_off_buys_more_room_on_the_next_try():
    provider = Provider(cut=1)
    result = await plan_with(provider)
    assert result.attempts == 2
    assert provider.rooms == [MAX_TOKENS, MAX_TOKENS + TOKENS_PER_RETRY]


async def test_the_room_keeps_growing_while_it_keeps_being_cut_off():
    # The run that found this was cut off three times in a row.
    provider = Provider(cut=2)
    await plan_with(provider)
    assert provider.rooms == [
        MAX_TOKENS,
        MAX_TOKENS + TOKENS_PER_RETRY,
        MAX_TOKENS + 2 * TOKENS_PER_RETRY,
    ]


async def test_a_plan_that_is_merely_wrong_gets_no_extra_room():
    """Rejected for a bad seat, not for length.

    Paying for a bigger budget here would be paying for the wrong problem, and
    on a reasoning model that budget is real money.
    """
    bad = json.dumps(
        {"tasks": [{"id": "t1", "title": "X", "assignee_seat": 9, "instruction": "go"}]}
    )

    class Wrong(Provider):
        async def stream(self, request, caps):
            self.rooms.append(request.max_tokens)
            yield TextChunk(bad if len(self.rooms) == 1 else GOOD)
            yield DoneChunk("stop", Usage(input_tokens=10, output_tokens=10))

    provider = Wrong(cut=0)
    await plan_with(provider)
    assert provider.rooms == [MAX_TOKENS, MAX_TOKENS]


async def test_it_still_gives_up_rather_than_growing_for_ever():
    # Three attempts and then the mission fails out loud. A planner that kept
    # doubling would spend the run's whole budget on a plan.
    provider = Provider(cut=99)
    with pytest.raises(PlanningFailed):
        await plan_with(provider)
    assert len(provider.rooms) == 3
