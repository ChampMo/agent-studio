"""Talking: send_message to a teammate, ask_user for a person (§16.7).

`send_message` is the other half of the split-team advice in §16.6. Telling
people to separate the agent that reads the web from the agent that writes
files is only useful if the two can then talk, so a message is delivered into
the recipient's next task rather than merely logged.

`ask_user` reuses M6 whole: the same `agent.request`, now with `kind:
"question"`, the same resolve endpoint, the same modal. The runner does the
publishing and the waiting — a tool never touches the bus itself, for the same
reason the runtime never does (§2.3).
"""

from __future__ import annotations

from .base import ToolContext, ToolFailed, ToolResult

MAX_MESSAGE_CHARS = 4000
MAX_QUESTION_CHARS = 2000


async def send_message(ctx: ToolContext, *, to: str, content: str) -> ToolResult:
    """Leave a message for a teammate, delivered when their turn comes."""
    mailbox = ctx.extras.get("mailbox")
    if mailbox is None:
        raise ToolFailed(
            "no_team", "this agent is not running as part of a team, so there is nobody to message"
        )
    body = (content or "").strip()
    if not body:
        raise ToolFailed("empty_message", "there is nothing to send")
    if not to or not to.strip():
        raise ToolFailed("no_recipient", "name the teammate to send this to")

    recipient = mailbox.resolve(to.strip())
    if recipient is None:
        known = ", ".join(mailbox.names()) or "nobody"
        raise ToolFailed(
            "unknown_recipient", f"no teammate called {to!r}; this team is: {known}"
        )

    mailbox.post(sender=ctx.agent_id, recipient=recipient, content=body[:MAX_MESSAGE_CHARS])
    return ToolResult(
        content=f"Message left for {to}. They will see it when their turn comes.",
        summary=f"messaged {to}",
        details={"to": recipient},
    )


async def ask_user(ctx: ToolContext, *, question: str) -> ToolResult:
    """Ask the person a question and wait for their answer."""
    asker = ctx.extras.get("ask")
    if asker is None:
        raise ToolFailed(
            "cannot_ask", "there is no one attached to this mission to ask"
        )
    body = (question or "").strip()
    if not body:
        raise ToolFailed("empty_question", "there is no question to ask")

    answer = await asker(ctx.agent_id, body[:MAX_QUESTION_CHARS])
    if answer is None:
        raise ToolFailed("unanswered", "the question was not answered")

    return ToolResult(
        content=f"The user answered: {answer}",
        summary="asked the user a question",
        details={"answered": True},
    )


class Mailbox:
    """Messages waiting for each member of one mission.

    Lives for the length of the mission and no longer. Nothing here is
    persisted: what was said is on the event log, which is the record, and a
    second copy in a table would be a second thing to keep true (§2.1).
    """

    def __init__(self, members: dict[str, str]) -> None:
        #: agent_id -> display name.
        self._names = dict(members)
        self._waiting: dict[str, list[tuple[str, str]]] = {}

    def names(self) -> list[str]:
        return sorted(self._names.values())

    def resolve(self, who: str) -> str | None:
        """Accept an agent id or a name, because a model will use either."""
        if who in self._names:
            return who
        lowered = who.lower()
        for agent_id, name in self._names.items():
            if name.lower() == lowered:
                return agent_id
        return None

    def post(self, *, sender: str, recipient: str, content: str) -> None:
        self._waiting.setdefault(recipient, []).append((sender, content))

    def collect(self, recipient: str) -> list[tuple[str, str]]:
        """Take everything waiting for this member, leaving the box empty."""
        return self._waiting.pop(recipient, [])

    def name_of(self, agent_id: str) -> str:
        return self._names.get(agent_id, agent_id)
