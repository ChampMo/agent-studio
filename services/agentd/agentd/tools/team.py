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

#: A button has to fit on one line and be readable a week later on the log.
MAX_OPTION_CHARS = 120

#: How many answers may be offered. Past a handful a list of buttons is a
#: second thing to read rather than a shortcut past reading, and the written
#: reply underneath already covers everything else.
MAX_OPTIONS = 6


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


async def ask_user(
    ctx: ToolContext,
    *,
    question: str,
    options: list[str] | None = None,
    recommended: str | None = None,
) -> ToolResult:
    """Ask the person a question and wait for their answer.

    `options` and `recommended` are carried through exactly as given. Nothing
    here invents them and nothing rewrites them: a suggestion has to be one
    somebody made, or the person cannot tell whose it is (§1.1).

    **`options` is a check, not a request.** The description asks for them and
    a description is a request; this project has already paid for that
    difference once, when the generator was asked not to reuse a name and did.
    A question with no answers offered is a paused run and an empty box, and
    the person is then doing again the thinking the agent has just spent a turn
    on. Refusing costs one round trip, which is less than that.

    It closes nothing: the written reply is always there underneath, so a list
    is a shortcut past typing rather than the set of legal answers. That is
    what makes "always" defensible here - offering the two decisions you can
    see is never wrong, because the person can still say a third thing.

    `recommended` is deliberately **not** checked the same way. A suggestion
    the agent did not mean would be shown as "<name> suggests", which is an
    opinion attributed to somebody who did not hold it (§1.1).

    The rest are the ones a person would notice being wrong. Blank and
    duplicate options are dropped, because a button with no label and two
    buttons with the same one are both unanswerable. And a `recommended` that
    is not one of the options is refused rather than shown - pointing at
    something that is not on screen is worse than pointing at nothing.
    """
    asker = ctx.extras.get("ask")
    if asker is None:
        raise ToolFailed(
            "cannot_ask", "there is no one attached to this mission to ask"
        )
    body = (question or "").strip()
    if not body:
        raise ToolFailed("empty_question", "there is no question to ask")

    # Bounded as it is built, not afterwards. The first version validated
    # `recommended` against the whole list and then published `seen[:6]`, so an
    # agent offering seven answers and naming the seventh passed the check and
    # was published beside six options that did not contain it - the exact
    # thing the docstring says must not happen, written into an append-only
    # table. Two lists cannot disagree if there is only one.
    seen: list[str] = []
    for raw in options or []:
        if len(seen) >= MAX_OPTIONS:
            break
        text = str(raw).strip()[:MAX_OPTION_CHARS]
        if text and text not in seen:
            seen.append(text)
    if not seen:
        raise ToolFailed(
            "no_options",
            "offer `options`: the answers you can actually see, two to four "
            "short phrases that each stand on their own. They do not close the "
            "question - the person can still write anything instead - so a "
            "list costs them nothing and usually saves them the typing. Name "
            "the one you would take in `recommended`, or leave it out if you "
            "genuinely have no preference.",
        )
    picked = (recommended or "").strip()[:MAX_OPTION_CHARS] or None
    if picked and picked not in seen:
        raise ToolFailed(
            "unknown_recommendation",
            f"{picked!r} is recommended but is not one of the options offered "
            f"({', '.join(seen) or 'none'}). At most {MAX_OPTIONS} options are "
            "carried, so name one of those or offer a shorter list.",
        )

    answer = await asker(ctx.agent_id, body[:MAX_QUESTION_CHARS], tuple(seen), picked)
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
