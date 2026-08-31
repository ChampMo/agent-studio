"""Human-in-the-loop (PROJECT_BRIEF.md §7, §12 M6).

The milestone's hard criterion is that a question survives closing the app. That
rules out holding the pause in memory: the process that asked has to be allowed
to die, and a different one has to be able to pick it up.

So the pause is LangGraph's `interrupt()` against a SQLite checkpointer, keyed
by mission id. Three facts follow from that, and each is a rule elsewhere:

* A waiting mission has **no running task**, on purpose. `reap_orphans()` must
  not mistake it for one abandoned by a crash — hence `status = "waiting"`.
* The question is on the event log (`agent.request`) *and* on the mission row
  (`pending_request`). The log is the record; the column is the index, so an
  answer can be routed without replaying every event to find what was asked.
* Resuming is re-entering the graph with `Command(resume=...)`, not continuing
  an object that is still in memory — because usually it is not.

`agent.request.resolved` is published when the answer arrives, so a replay shows
the question *and* the answer. Without it the timeline shows an agent asking
something and then acting on nothing.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Literal

from langgraph.types import interrupt

RequestKind = Literal["question", "approval"]


@dataclass(frozen=True)
class Ask:
    """What the graph puts in front of the user."""

    request_id: str
    kind: RequestKind
    agent_id: str
    question: str
    options: list[str] | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "agentId": self.agent_id,
            "requestId": self.request_id,
            "kind": self.kind,
            "question": self.question,
        }
        if self.options:
            payload["options"] = self.options
        return payload


def new_request_id() -> str:
    return f"req-{uuid.uuid4()}"


APPROVE = "approve"
REJECT = "reject"


def ask_to_approve(*, agent_id: str, request_id: str, summary: str) -> Ask:
    return Ask(
        request_id=request_id,
        kind="approval",
        agent_id=agent_id,
        question=f"Approve this plan before the team starts?\n\n{summary}",
        options=[APPROVE, REJECT],
    )


def pause(ask: Ask) -> str:
    """Stop the graph here and wait for a person.

    Everything above this line has been checkpointed by the time it returns.
    The value handed back is whatever `Command(resume=...)` carried, which may
    arrive from an entirely different process minutes or days later.
    """
    answer = interrupt(
        {
            "requestId": ask.request_id,
            "kind": ask.kind,
            "agentId": ask.agent_id,
            "question": ask.question,
            "options": ask.options,
        }
    )
    return str(answer)


class PlanRejected(RuntimeError):
    """The user declined the plan. Not a failure — a decision, and the mission
    ends saying so rather than pretending something went wrong."""

    def __init__(self, note: str) -> None:
        super().__init__(note or "the plan was rejected")
        self.note = note
