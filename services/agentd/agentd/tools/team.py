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

    try:
        recipient = mailbox.resolve(to.strip())
    except Ambiguous as clash:
        # Told to the model as a failure it can act on, rather than guessed at.
        raise ToolFailed(
            "ambiguous_recipient",
            f"{len(clash.names)} teammates are called {clash.asked!r}, so this "
            "message has nowhere unambiguous to go. Ask the user to rename one.",
        ) from None
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


class Ambiguous(Exception):
    """More than one teammate answers to that name."""

    def __init__(self, asked: str, names: list[str]) -> None:
        super().__init__(asked)
        self.asked = asked
        self.names = names


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

    def recipients(self) -> list[str]:
        """Every member, by id. Used to hand the user's note to whoever runs
        next — each one collects it once, because `collect` empties the box."""
        return list(self._names)

    def resolve(self, who: str) -> str | None:
        """Accept an agent id or a name, because a model will use either.

        Raises `Ambiguous` when a name fits more than one teammate. The old
        version returned the first match, so on a team with two agents called
        "Mara" a message meant for one was delivered to the other with nothing
        reported — the worst kind of failure, because the sender is told it
        worked. The team validator refuses such a team up front; this is the
        second half, for a team that predates that check or was hand-edited.
        """
        if who in self._names:
            return who
        lowered = who.strip().casefold()

        exact = [
            agent_id
            for agent_id, name in self._names.items()
            if name.strip().casefold() == lowered
        ]
        if len(exact) > 1:
            raise Ambiguous(who, [self._names[a] for a in exact])
        if exact:
            return exact[0]

        # Then part of a name. A roster reads "Developer (Dev)", and an agent
        # asked to hand work to the developer writes "Developer", or "Dev".
        # Both were refused, and one real run spent five turns cycling through
        # "Dev", "Developer", "PM" and "Project Manager" before giving up — the
        # file it was meant to hand on never got written.
        #
        # Still never a guess: two teammates that both fit raises, exactly as an
        # exact collision does. Narrower before wider, so "Dev" prefers a
        # teammate whose name starts with it over one that merely contains it.
        for pick in (
            lambda name: name.startswith(lowered),
            lambda name: lowered in name,
        ):
            matches = [
                agent_id
                for agent_id, name in self._names.items()
                if pick(name.strip().casefold())
            ]
            if len(matches) > 1:
                raise Ambiguous(who, [self._names[a] for a in matches])
            if matches:
                return matches[0]
        return None

    def post(self, *, sender: str, recipient: str, content: str) -> None:
        self._waiting.setdefault(recipient, []).append((sender, content))

    def collect(self, recipient: str) -> list[tuple[str, str]]:
        """Take everything waiting for this member, leaving the box empty."""
        return self._waiting.pop(recipient, [])

    def name_of(self, agent_id: str) -> str:
        return self._names.get(agent_id, agent_id)
