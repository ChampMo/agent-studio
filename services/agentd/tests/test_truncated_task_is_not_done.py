"""A turn that was cut off did not finish, so its task is not `done`.

From a real run (`WEBDEV`, five agents, 147k tokens). The designer had no
`write_file`, so its plan was to hand the whole design spec to the developer
through `send_message` — and the log says exactly what became of that:

    seq 58  agent.message      "...handing the full document to the
                                implementer now, then including it below
                                for the record."         (cut off here)
    seq 59  error              tool_call_truncated — call to 'send_message'
                                was cut off at max_tokens; not executed
    seq 61  error              output_truncated — the reply hit max_tokens
    seq 62  mission.progress   t2 -> **done**

Nothing was written, nothing was delivered, and two `error` events saying so
sat one and three events above the line calling it done.

It passed because `answer.strip()` was not empty: the model had written eight
hundred characters of *what it was about to hand over* before the cap hit.
Non-empty text means the model said something. It has never meant the work is
finished.

What the false `done` cost is why this is worth a test rather than a comment.
The two agents after it were told the spec existed; they spent four minutes of
a fifteen-minute budget running `find /` for it — two of those calls hit the
shell timeout — and the run parked on a question asking the user where the
files were.

The existing rule ("a task that produced nothing is not done") is the same
rule one step short. These are the tests for the step.
"""

from __future__ import annotations

from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.orchestrator.graph import run_team_mission
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

PLAN = (
    '{"tasks": ['
    '{"id": "t1", "title": "Spec", "assignee_seat": 1, '
    '"instruction": "Describe the design."}'
    "]}"
)


def limits() -> BudgetLimits:
    return BudgetLimits(
        max_llm_calls=50, max_supersteps=50, max_tokens=1_000_000, timeout_sec=300
    )


def member(seat: int, agent_id: str, name: str, *, leader: bool = False):
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


def roster() -> RosterSnapshot:
    return RosterSnapshot(
        [member(0, "a-lead", "Lead", leader=True), member(1, "a-one", "One")]
    )


class Model:
    """Plans cleanly; every other turn ends however the test says."""

    kind = "fake"

    def __init__(self, *, worker: str, stop: str) -> None:
        self._worker = worker
        self._stop = stop

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        if req.response_schema:
            yield TextChunk(PLAN)
            yield DoneChunk("stop", Usage(20, 30))
            return
        yield TextChunk(self._worker)
        yield DoneChunk(self._stop, Usage(20, 30))

    async def aclose(self):
        return None


async def run(model: Model) -> list[dict]:
    items = []
    async for item in run_team_mission(
        mission_id="m-1",
        snapshot=roster(),
        goal="Describe the design.",
        budget=BudgetTracker(limits()),
        provider_for=lambda _m: (model, Capabilities()),
    ):
        if item.get("channel") != "ephemeral":
            items.append(item)
    return items


def outcome(items: list[dict], task_id: str = "t1") -> str:
    states = [
        i["payload"]["state"]
        for i in items
        if i["type"] == "mission.progress" and i["payload"].get("taskId") == task_id
    ]
    return states[-1]


def codes(items: list[dict]) -> list[str]:
    return [i["payload"]["code"] for i in items if i["type"] == "error"]


async def test_a_reply_cut_off_at_max_tokens_is_not_done():
    """The bug, at its smallest: text came back, and the turn did not finish.

    This is `WEBDEV` task 2 with everything incidental removed — no missing
    tool, no lost `send_message`, just a reply that stopped mid-sentence.
    """
    items = await run(
        Model(
            worker="Here is the spec I am about to hand over: the gradient mesh",
            stop="length",
        )
    )

    assert outcome(items) == "failed"
    assert "output_truncated" in codes(items)
    assert "task_produced_nothing" in codes(items)


async def test_the_failure_says_it_was_cut_off_rather_than_empty():
    """Three things end a turn with nothing usable and they need different
    answers: an empty reply is a model that spent its room reasoning, a cut-off
    reply is a task too big for one turn, and a lost tool call is an action
    that never happened. One phrase for all three sends the reader the wrong
    way — the same reason `budget_exceeded` had to start naming its limit.
    """
    items = await run(Model(worker="the gradient mesh", stop="length"))
    said = [
        i["payload"]["message"]
        for i in items
        if i["type"] == "error" and i["payload"]["code"] == "task_produced_nothing"
    ]
    # Listed rather than `next`, so a build that records this task `done`
    # fails here saying the report is missing instead of raising StopIteration
    # from inside the helper.
    assert said, "the task was recorded done, so nothing reported why"
    assert "cut off at max_tokens" in said[0]


async def test_a_turn_that_finished_is_still_done():
    """The regression that matters most. Nearly every task ends this way, and
    a check that failed them would be far worse than the bug it fixes."""
    items = await run(Model(worker="The design is a soft gradient mesh.", stop="stop"))

    assert outcome(items) == "done"
    assert codes(items) == []


async def test_an_empty_reply_still_fails_the_way_it_always_did():
    """The original rule, unchanged: a turn that emitted nothing is not done
    however cleanly it stopped."""
    items = await run(Model(worker="", stop="stop"))

    assert outcome(items) == "failed"
    assert "task_produced_nothing" in codes(items)
