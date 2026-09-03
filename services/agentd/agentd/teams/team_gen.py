"""Compose a team from the agents that exist, and read one against a brief.

Two operations, and the line between them and `validator.py` is the whole
design.

**The model composes. The validator gates.** That is not caution about LLMs in
general — it is a specific bug this project shipped. A research team was given
`web_search` and `web_fetch`, ran to completion, and answered from memory,
because the tools were on the **leader**, and a leader with workers is never
assigned a task. Ask a model *"does this team have web access?"* and it says
yes: every tool is present, on a real member, spelled correctly. Only a
deterministic rule that knows how the orchestrator distributes work catches it,
and `leader_only_tool` is that rule.

So a proposal is run through `validate()` before it is returned, and the
findings travel with it. The model is good at the thing the validator cannot do
— reading a paragraph of English and knowing that "check the copy against the
brand guide" wants someone who can read files — and hopeless at the thing the
validator is for.

Nothing here writes. A proposal is shown to be edited, exactly as §11 requires
of a generated profile, and the same rule applies for the same reason: this is
a suggestion about the user's own roster, and the user is the one who knows.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from pydantic import BaseModel, Field, ValidationError, field_validator

from ..core.jsonish import extract_json
from ..db.models import Agent
from ..providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    LLMProvider,
    Message,
    ProviderError,
    TextChunk,
    Usage,
    was_truncated,
)
from . import layouts

log = logging.getLogger("agentd.team_gen")

#: A proposal is a handful of short strings per member, plus reasons. Larger
#: than a profile because it covers several people; small enough that a
#: reasoning model still reaches the JSON.
MAX_TOKENS = 6144

#: Truncation is the one failure worth buying room for — the model was not
#: wrong, it ran out. Same rule the planner learned: a correction telling it to
#: be briefer is advice about output it never reached.
TOKENS_PER_RETRY = 4096

MAX_ATTEMPTS = 3

SUGGEST_PROMPT = """You staff a team for a piece of work, choosing from people \
who already exist. You do not invent teammates.

Return ONE JSON object and nothing else. No prose, no markdown fence.

  "layoutId":  one of the layout ids below
  "members":   an ARRAY of the people to put on this team
  "gaps":      an ARRAY of roles the work needs that NOBODY below can fill.
               Empty is the normal answer. Only use it when no existing person
               is a reasonable fit — not merely when someone is imperfect.

Each member is an object:

  "agentId":   an id from the roster below, exactly as written
  "seat":      a seat number, 0-based, unique within the team
  "role":      "leader" or "worker". EXACTLY ONE leader.
  "addTools":  an ARRAY of tool ids this person is missing and needs for THIS
               work. Empty is the normal answer. Do not repeat tools they
               already carry.
  "why":       one short sentence: what this person is here to do

Each gap is an object:

  "role":      the missing job, a few words
  "why":       one sentence on what the work needs it for
  "tools":     an ARRAY of tool ids that job would need

How work is actually distributed, which decides how you staff it:

* The leader does not do the work. It plans, delegates, and writes the summary
  at the end. It is never assigned a task while the team has workers.
* Therefore a tool that only the leader carries is a tool NOBODY CAN USE.
  Put every tool on the workers who will use it.
* Teammates cannot borrow each other's tools. A task that writes a file must
  go to somebody who carries `write_file`.
* Two people with the same name cannot be told apart when they message each
  other, so do not seat two people with the same name.

The roster, one per line — id, name, title, and the tools they carry today:
{roster}

Tool ids, and what each one is for:
{tools}

Layouts, and how many seats each has:
{layouts}
"""

REVIEW_PROMPT = """You read a team against a piece of work and say whether they \
are equipped for it.

Return ONE JSON object and nothing else. No prose, no markdown fence.

  "verdict": one sentence — can this team do this work as it stands?
  "notes":   an ARRAY of specific remarks, at most 6. Empty is a real answer
             and the right one for a team that fits.

Each note is an object:

  "about":   the name of the member it concerns, or "" for the team as a whole
  "kind":    "missing_tool" | "wrong_fit" | "gap" | "risk" | "note"
  "message": one or two sentences, concrete. Name the tool or the step.

Judge only what the brief actually asks for. Do not ask for tools the work does
not need — a team that is right is a team with nothing to say about it.

What you are reading for:

* Can the work be finished with the tools these people carry? A task that
  writes files needs somebody carrying `write_file`; research needs the web
  tools; nobody can borrow.
* The leader plans and summarises and is never assigned a task, so a tool only
  the leader has cannot be used by anyone.
* Is anyone here who has nothing to do in this particular work?

The work:
{brief}

The team, one member per line:
{team}

Tool ids that exist on this machine, and what each is for:
{tools}
"""


class ProposedMember(BaseModel):
    agent_id: str = Field(alias="agentId")
    seat: int = Field(ge=0)
    role: str
    add_tools: list[str] = Field(default_factory=list, alias="addTools")
    why: str = Field(default="", max_length=400)

    model_config = {"populate_by_name": True}

    @field_validator("role")
    @classmethod
    def _real_role(cls, role: str) -> str:
        if role not in ("leader", "worker"):
            raise ValueError("role must be 'leader' or 'worker'")
        return role

    @field_validator("add_tools")
    @classmethod
    def _known_tools_only(cls, tools: list[str]) -> list[str]:
        return _check_tools(tools)


class ProposedGap(BaseModel):
    role: str = Field(min_length=1, max_length=120)
    why: str = Field(default="", max_length=400)
    tools: list[str] = Field(default_factory=list)

    @field_validator("tools")
    @classmethod
    def _known_tools_only(cls, tools: list[str]) -> list[str]:
        return _check_tools(tools)


class ProposedTeam(BaseModel):
    layout_id: str = Field(alias="layoutId")
    members: list[ProposedMember] = Field(min_length=1)
    gaps: list[ProposedGap] = Field(default_factory=list)

    model_config = {"populate_by_name": True}

    @field_validator("layout_id")
    @classmethod
    def _known_layout(cls, layout_id: str) -> str:
        if not layouts.is_known(layout_id):
            known = ", ".join(l["id"] for l in layouts.catalogue())  # type: ignore[index]
            raise ValueError(f"unknown layout '{layout_id}'. Choose from: {known}")
        return layout_id


class ReviewNote(BaseModel):
    about: str = Field(default="", max_length=120)
    kind: str = Field(default="note")
    message: str = Field(min_length=1, max_length=600)

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, kind: str) -> str:
        # Not an enum the model can widen: an unknown kind would reach the UI
        # with no colour, no icon and no meaning. Anything unrecognised is a
        # plain note, which is true of it.
        return kind if kind in NOTE_KINDS else "note"


NOTE_KINDS = {"missing_tool", "wrong_fit", "gap", "risk", "note"}


class TeamReview(BaseModel):
    verdict: str = Field(min_length=1, max_length=600)
    notes: list[ReviewNote] = Field(default_factory=list, max_length=6)


def _check_tools(tools: list[str]) -> list[str]:
    """The closed-catalogue rule, the third place it appears in this codebase.

    Chosen from what exists, never invented — the same as the avatar slots and
    an agent's own tools. A model that names `search_web` gets a correction
    listing the real ids, rather than a team that fails at launch.
    """
    from ..tools import registry as tool_registry

    unknown = [t for t in tools if t not in tool_registry.BY_ID]
    if unknown:
        raise ValueError(
            f"unknown tools: {', '.join(unknown)}. "
            f"Choose from: {', '.join(sorted(tool_registry.BY_ID))}"
        )
    return sorted(dict.fromkeys(tools))


class TeamGenerationFailed(RuntimeError):
    def __init__(self, attempts: list[str], usage: Usage) -> None:
        super().__init__(attempts[-1] if attempts else "no attempts were made")
        self.attempts = attempts
        self.usage = usage


@dataclass
class SuggestResult:
    proposal: ProposedTeam
    usage: Usage = field(default_factory=Usage)
    attempts: int = 1
    recovered_from: list[str] = field(default_factory=list)


@dataclass
class ReviewResult:
    review: TeamReview
    usage: Usage = field(default_factory=Usage)
    attempts: int = 1
    recovered_from: list[str] = field(default_factory=list)


def roster_text(agents: list[Agent]) -> str:
    """Who exists, and what they carry today.

    The tools are the load-bearing part. `_roster_text` in the planner learned
    this the expensive way: a leader choosing an assignee from a name and a
    title gave "create INDEX.md" to a designer who could not write files, and
    it spent five turns trying to hand the work on.
    """
    lines = []
    for agent in agents:
        tools = ", ".join(agent.tools) if agent.tools else "none"
        lines.append(f"  {agent.id}  {agent.name} — {agent.title}  [tools: {tools}]")
    return "\n".join(lines) if lines else "  (nobody yet)"


def tools_text(tool_ids: list[str] | None = None) -> str:
    from ..tools import registry as tool_registry

    specs = [
        spec
        for spec in tool_registry.all_specs()
        if tool_ids is None or spec.id in tool_ids
    ]
    return "\n".join(
        f"  {spec.id:<14}{spec.risk:<10}{spec.description.splitlines()[0]}"
        for spec in specs
    )


def layouts_text() -> str:
    return "\n".join(
        f"  {entry['id']:<12}{entry['seats']} seats — {entry['description']}"
        for entry in layouts.catalogue()
    )


def team_text(members: list[tuple[Agent, str, list[str]]]) -> str:
    """One line per member: who they are, their role, and their effective tools.

    Effective, not the agent's own — a per-team `tool_subset` override is what
    the run will actually use, and reviewing the agent's full set would be
    reading a different team from the one that runs (§5.1).
    """
    lines = []
    for agent, role, tools in members:
        carried = ", ".join(tools) if tools else "none"
        lines.append(
            f"  {agent.name} — {agent.title} ({role})  [tools: {carried}]"
        )
    return "\n".join(lines) if lines else "  (nobody)"


def _describe(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        where = ".".join(str(p) for p in err["loc"]) or "(root)"
        parts.append(f"{where}: {err['msg']}")
    return "; ".join(parts)


def _check_proposal(proposal: ProposedTeam, agents: dict[str, Agent]) -> str | None:
    """The corrections only this caller can make, because only it knows the
    roster. Returned as one message so a retry fixes everything at once."""
    problems: list[str] = []

    unknown = [m.agent_id for m in proposal.members if m.agent_id not in agents]
    if unknown:
        problems.append(
            f"these agentIds are not on the roster: {', '.join(unknown)}. "
            f"Use ids exactly as given: {', '.join(sorted(agents))}"
        )

    seats = [m.seat for m in proposal.members]
    if len(set(seats)) != len(seats):
        problems.append("two members share a seat; every seat must be different")

    limit = layouts.get(proposal.layout_id).seats
    over = [s for s in seats if s >= limit]
    if over:
        problems.append(
            f"layout '{proposal.layout_id}' has {limit} seats (0-{limit - 1}), "
            f"so these are out of range: {', '.join(str(s) for s in over)}"
        )

    leaders = [m for m in proposal.members if m.role == "leader"]
    if len(leaders) != 1:
        problems.append(f"exactly one leader is required; this has {len(leaders)}")

    repeated = [
        agent_id
        for agent_id in {m.agent_id for m in proposal.members}
        if sum(1 for m in proposal.members if m.agent_id == agent_id) > 1
    ]
    if repeated:
        problems.append(
            f"the same person is seated twice: {', '.join(sorted(repeated))}"
        )

    return "; ".join(problems) if problems else None


async def suggest_team(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    brief: str,
    agents: list[Agent],
    available_tools: list[str] | None = None,
    max_attempts: int = MAX_ATTEMPTS,
) -> SuggestResult:
    """Staff a team for this brief, from the people who already exist."""
    by_id = {agent.id: agent for agent in agents}
    system = SUGGEST_PROMPT.format(
        roster=roster_text(agents),
        tools=tools_text(available_tools),
        layouts=layouts_text(),
    )
    messages = [Message("user", f"The work:\n{brief.strip()}")]

    def parse(text: str) -> tuple[ProposedTeam | None, str | None]:
        try:
            payload = json.loads(extract_json(text))
        except json.JSONDecodeError as exc:
            return None, f"the reply was not valid JSON ({exc})"
        try:
            proposal = ProposedTeam.model_validate(payload)
        except ValidationError as exc:
            return None, _describe(exc)
        problem = _check_proposal(proposal, by_id)
        return (None, problem) if problem else (proposal, None)

    value, usage, attempts, failures = await _ask(
        provider, caps, model, system, messages, parse, max_attempts
    )
    return SuggestResult(
        proposal=value, usage=usage, attempts=attempts, recovered_from=failures
    )


async def review_team(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    brief: str,
    members: list[tuple[Agent, str, list[str]]],
    available_tools: list[str] | None = None,
    max_attempts: int = MAX_ATTEMPTS,
) -> ReviewResult:
    """Read this team against this brief.

    Advisory, always. It returns remarks, never a severity — a `warn` from a
    model would sit in the same list as a `warn` from `validator.py` and be
    read as the same kind of claim, and they are not: one is a rule about how
    the orchestrator distributes work, the other is an opinion about a
    paragraph of English.
    """
    system = REVIEW_PROMPT.format(
        brief=brief.strip(),
        team=team_text(members),
        tools=tools_text(available_tools),
    )
    messages = [Message("user", "Read this team against the work above.")]

    def parse(text: str) -> tuple[TeamReview | None, str | None]:
        try:
            payload = json.loads(extract_json(text))
        except json.JSONDecodeError as exc:
            return None, f"the reply was not valid JSON ({exc})"
        try:
            return TeamReview.model_validate(payload), None
        except ValidationError as exc:
            return None, _describe(exc)

    value, usage, attempts, failures = await _ask(
        provider, caps, model, system, messages, parse, max_attempts
    )
    return ReviewResult(
        review=value, usage=usage, attempts=attempts, recovered_from=failures
    )


async def _ask(
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    system: str,
    messages: list[Message],
    parse,
    max_attempts: int,
):
    """Ask, validate, correct — the loop `profile_gen` established in M2.

    The correction feeds the model its own reply back. Re-asking from scratch
    throws away whatever it got right, which on a proposal is usually most of
    it: one bad seat number does not mean the staffing was wrong.
    """
    total = Usage()
    failures: list[str] = []
    room = MAX_TOKENS

    for attempt in range(1, max_attempts + 1):
        text, usage, stop_reason = await _one_attempt(
            provider, caps, model, system, messages, room
        )
        total = Usage(
            input_tokens=total.input_tokens + usage.input_tokens,
            output_tokens=total.output_tokens + usage.output_tokens,
            cache_read_tokens=total.cache_read_tokens + usage.cache_read_tokens,
            cache_write_tokens=total.cache_write_tokens + usage.cache_write_tokens,
        )

        if was_truncated(stop_reason):
            # Room, not advice. The tokens went on reasoning before the first
            # visible character, so "be briefer" is a correction about output
            # the model never reached — the lesson `TOKENS_PER_RETRY` already
            # carries in the planner.
            room += TOKENS_PER_RETRY
            problem = "the reply was cut off before the JSON closed"
        else:
            value, problem = parse(text)
            if value is not None:
                return value, total, attempt, failures

        failures.append(problem or "unknown failure")
        log.info("team generation attempt %d failed: %s", attempt, problem)
        if attempt < max_attempts:
            messages = messages + [
                Message("assistant", text[:2000]),
                Message(
                    "user",
                    f"That was rejected: {problem}. "
                    "Return the corrected JSON object only.",
                ),
            ]

    raise TeamGenerationFailed(failures, total)


async def _one_attempt(
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    system: str,
    messages: list[Message],
    max_tokens: int,
) -> tuple[str, Usage, str | None]:
    request = ChatRequest(
        model=model,
        messages=messages,
        system=system,
        max_tokens=max_tokens,
    )
    parts: list[str] = []
    usage = Usage()
    stop_reason: str | None = None

    try:
        async for chunk in provider.stream(request, caps):
            if isinstance(chunk, TextChunk):
                parts.append(chunk.text)
            elif isinstance(chunk, DoneChunk):
                usage, stop_reason = chunk.usage, chunk.stop_reason
    except ProviderError:
        # A 401 or an unreachable endpoint will not fix itself on the next
        # attempt, and three calls to reach the same answer is the user's money.
        raise

    return "".join(parts), usage, stop_reason
