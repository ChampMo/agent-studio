"""A task that runs after a failure is told there was one.

A worker is handed its own instruction and nothing else, so the plan marched
straight over a hole. On a real run (`PARADOX.ART`, 2,159,380 tokens) both
build tasks failed, and the two QA tasks then ran anyway — inspecting a site
that had never been written, in a workspace whose only entry was `docs/`.

Nothing in the app noticed. `ok` is set on every task result and was read in
exactly one place: assembling the leader's closing summary. Not to retry, not
to stop the tasks that depended on it, and not to tell them.

The fix is the fact, not an instruction about what to do with it — agents
already behave sensibly when they can tell. The QA agent that *could* see the
empty workspace opened its report with *"neither file exists in the workspace,
the pass is unmeasurable"* instead of inventing a result.
"""

from __future__ import annotations

from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.orchestrator.graph import run_team_mission
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

PLAN = (
    '{"tasks": ['
    '{"id": "t1", "title": "Build index.html", "assignee_seat": 1,'
    ' "instruction": "Build index.html, the page shell."},'
    '{"id": "t2", "title": "QA the page", "assignee_seat": 2,'
    ' "instruction": "Check index.html against the spec."}'
    "]}"
)

BOTH_FINE = (
    '{"tasks": ['
    '{"id": "t1", "title": "Write the notes", "assignee_seat": 1,'
    ' "instruction": "Say what you think."},'
    '{"id": "t2", "title": "Review them", "assignee_seat": 2,'
    ' "instruction": "Say what you think of it."}'
    "]}"
)


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
        avatar_config={
            "breed": "tuxedo",
            "size": "normal",
            "headwear": "none",
            "glasses": "none",
            "collar": "none",
        },
    )


def roster():
    return RosterSnapshot(
        [
            member(0, "a-lead", "Lead", leader=True),
            member(1, "a-one", "One"),
            member(2, "a-two", "Two"),
        ]
    )


class Model:
    """Plans as told; the first worker turn ends however the test says."""

    kind = "fake"

    def __init__(self, plan: str, *, fail_first: bool = False) -> None:
        self._plan = plan
        self._fail_first = fail_first
        self.turns: list[str] = []

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        if req.response_schema:
            yield TextChunk(self._plan)
            yield DoneChunk("stop", Usage(20, 30))
            return
        # Every worker turn's whole first message, so the test can read what
        # the second one was actually told.
        self.turns.append(req.messages[0].content)
        if self._fail_first and len(self.turns) == 1:
            # Cut off mid-sentence: said something, finished nothing, and is
            # not the empty-reply case — that one now buys another attempt
            # (see test_empty_round_gets_another_go.py), so using it here
            # would test the retry rather than the notice.
            yield TextChunk("I am about to write index.html, starting with")
            yield DoneChunk("length", Usage(20, 16384))
            return
        yield TextChunk("Checked.")
        yield DoneChunk("stop", Usage(20, 30))

    async def aclose(self):
        return None


async def run(model):
    out = []
    async for item in run_team_mission(
        mission_id="m-1",
        snapshot=roster(),
        goal="Build the store.",
        budget=BudgetTracker(
            BudgetLimits(
                max_llm_calls=50, max_supersteps=50, max_tokens=10**6, timeout_sec=300
            )
        ),
        provider_for=lambda _m: (model, Capabilities()),
    ):
        if item.get("channel") != "ephemeral":
            out.append(item)
    return out


def states(items):
    return {
        i["payload"]["taskId"]: i["payload"]["state"]
        for i in items
        if i["type"] == "mission.progress" and i["payload"].get("taskId")
    }


async def test_the_next_task_is_told_which_one_failed():
    model = Model(PLAN, fail_first=True)
    items = await run(model)

    assert states(items)["t1"] == "failed"
    second = model.turns[1]
    assert "Build index.html" in second, second[:300]
    assert "failed and produced nothing" in second
    # The fact, not a decision made on the agent's behalf.
    assert "check" in second.lower()


async def test_its_own_instruction_still_reaches_it_intact():
    model = Model(PLAN, fail_first=True)
    await run(model)
    assert "Check index.html against the spec." in model.turns[1]


async def test_a_plan_with_no_failures_says_nothing_extra():
    # The notice must not become a line every task carries: a warning that
    # always fires is not a warning.
    model = Model(BOTH_FINE)
    items = await run(model)

    assert states(items)["t1"] == "done"
    assert "failed and produced nothing" not in model.turns[1]
    assert model.turns[1].startswith("Say what you think of it.")
