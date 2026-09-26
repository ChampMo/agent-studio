"""A task asked for a file, and wrote none, is not `done`.

From the real `PARADOX.ART` run: 1,411,863 tokens, a five-task round with
**every task recorded `done`**, the round recorded **`completed`**, and a
workspace holding no `index.html` and no `css/style.css`.

    mission.progress  "Build index.html semantic shell"  -> done
    mission.progress  "Build css/style.css"              -> done
    mission.ended     reason=completed
    on disk           docs/*.md, js/app.js  — and nothing else

Nothing downstream could catch it. `ending_for` turns a run `failed` when a
*task* failed, so with every task claiming success it had nothing to correct:
the task states lied first. Both build agents had replied with prose about the
file they were about to write and never called a tool, and `answer.strip()`
being non-empty was the whole of the test.

The other two parties were honest, which is what makes the record the liar.
The QA agent opened its report with *"Neither `index.html` nor `css/style.css`
exists in the workspace"*, and the leader's own summary opened with *"The round
produced nothing of the deliverable... Nothing was built."* — under a row that
said `completed`.
"""

from __future__ import annotations

from agentd.core.budget import BudgetLimits, BudgetTracker
from agentd.orchestrator.graph import run_team_mission
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

WRITES = (
    '{"tasks": ['
    '{"id": "t1", "title": "Build index.html", "assignee_seat": 1, '
    '"instruction": "Build index.html, the semantic shell for the store."}'
    "]}"
)
NO_FILE = (
    '{"tasks": ['
    '{"id": "t1", "title": "Review the spec", "assignee_seat": 1, '
    '"instruction": "Read the spec and report what is unclear."}'
    "]}"
)


def member(seat, agent_id, name, *, leader=False):
    return SnapshotMember(
        agent_id=agent_id, name=name, seat_index=seat,
        role_in_team="leader" if leader else "member",
        system_prompt=f"You are {name}.", provider_id="prov-1", model="m1",
        sampling=None, tools=[],
        avatar_config={"breed": "tuxedo", "size": "normal", "headwear": "none",
                       "glasses": "none", "collar": "none"},
    )


def roster():
    return RosterSnapshot(
        [member(0, "a-lead", "Lead", leader=True), member(1, "a-one", "One")]
    )


class Model:
    """Plans as told, then replies with prose and calls no tool."""

    kind = "fake"

    def __init__(self, plan: str, reply: str) -> None:
        self._plan, self._reply = plan, reply

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        if req.response_schema:
            yield TextChunk(self._plan)
            yield DoneChunk("stop", Usage(20, 30))
            return
        yield TextChunk(self._reply)
        yield DoneChunk("stop", Usage(20, 30))

    async def aclose(self):
        return None


async def run(model):
    out = []
    async for item in run_team_mission(
        mission_id="m-1", snapshot=roster(), goal="Build the store.",
        budget=BudgetTracker(BudgetLimits(
            max_llm_calls=50, max_supersteps=50, max_tokens=10**6, timeout_sec=300)),
        provider_for=lambda _m: (model, Capabilities()),
    ):
        if item.get("channel") != "ephemeral":
            out.append(item)
    return out


def outcome(items, task_id="t1"):
    return [i["payload"]["state"] for i in items
            if i["type"] == "mission.progress"
            and i["payload"].get("taskId") == task_id][-1]


def codes(items):
    return [i["payload"]["code"] for i in items if i["type"] == "error"]


#: What the real agent did: described the file at length, wrote nothing.
PROSE = (
    "I have built the semantic shell for index.html. It uses a header, a main "
    "landmark with the gallery, and a footer, with the ids from the spec."
)


async def test_describing_the_file_is_not_writing_it():
    items = await run(Model(WRITES, PROSE))

    assert outcome(items) == "failed", (
        "non-empty text has never meant the work is done, and here it meant "
        "the opposite: the reply is a description of a file that is not there"
    )
    assert "task_produced_nothing" in codes(items)


async def test_the_failure_says_the_file_is_what_is_missing():
    items = await run(Model(WRITES, PROSE))
    said = [i["payload"]["message"] for i in items
            if i["type"] == "error" and i["payload"]["code"] == "task_produced_nothing"]
    # Four reasons now share this code, and they need different answers: empty,
    # cut off, a lost tool call, and this one.
    assert "none was written" in said[0], said[0]


async def test_the_round_is_not_completed_when_the_file_is_missing():
    """The part that reached the person: a green `completed` over an empty
    folder.

    The orchestrator yields and the runner publishes the ending, so the link
    to assert here is the one that was broken: `ending_for` can only correct
    what the task states admit, and with every task claiming `done` it said
    `completed`. Give it the state this fix now produces and it says `failed`.
    """
    from agentd.agents.runner import ending_for

    items = await run(Model(WRITES, PROSE))
    states = {
        i["payload"]["taskId"]: (i["payload"]["state"], i["payload"]["label"])
        for i in items
        if i["type"] == "mission.progress" and i["payload"].get("taskId")
    }
    assert ending_for("completed", "summary", states)[0] == "failed"
    # And the shape that fooled it before: everything `done` reads completed,
    # which is correct — the lie was upstream, in the state itself.
    assert ending_for(
        "completed", "summary", {"t1": ("done", "Build index.html")}
    )[0] == "completed"


async def test_a_task_that_was_never_about_a_file_still_finishes_on_prose():
    # The guard must not turn every thinking task into a failure: reviewing,
    # reporting and answering are done by saying something.
    items = await run(Model(NO_FILE, "The spec is unclear about the cart total."))

    assert outcome(items) == "done"
    assert "task_produced_nothing" not in codes(items)
