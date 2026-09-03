"""Two endpoints that ask a model about a team, kept apart from the one that
decides whether it may run.

`teams.py` holds CRUD and `POST /teams/{id}/validate`, which is the gate. This
holds `suggest` and `review`, which are opinions. The separation is not
tidiness — it is the answer to the question these features raise, which is
whether a model can be trusted to say a team is properly equipped.

It cannot, and the evidence is in this repository. A research team carrying
`web_search` and `web_fetch` ran to completion and answered from memory,
because the tools sat on the **leader**, and a leader with workers is never
assigned a task. Ask a model whether that team has web access and it says yes:
every tool is present, on a real member, spelled correctly. `leader_only_tool`
catches it because it knows how the orchestrator distributes work.

So both endpoints run `validate()` over what they are talking about and return
its findings under their own key, beside the model's prose and never mixed into
it. The model is good at reading a paragraph of English and knowing the work
needs somebody who can write files. The validator is good at knowing that the
person it chose cannot be given a task.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..core import secrets
from ..db.models import Agent, ProviderProfile, TeamMember
from ..providers import registry
from ..providers.base import ProviderError
from ..teams.service import TeamNotFound, TeamService
from ..teams.team_gen import TeamGenerationFailed, review_team, suggest_team
from ..teams.validator import _effective_tools, can_run, validate
from ..tools import registry as tool_registry
from .deps import get_db, require_token

router = APIRouter(dependencies=[Depends(require_token)])


class MemberDraft(BaseModel):
    agent_id: str
    seat_index: int = Field(ge=0)
    role_in_team: str = "member"
    overrides: dict[str, Any] | None = None


class SuggestIn(BaseModel):
    brief: str = Field(min_length=1, max_length=4000)
    provider_id: str


class ReviewIn(BaseModel):
    brief: str = Field(min_length=1, max_length=4000)
    provider_id: str
    #: An unsaved team, so the builder can ask about what is on screen rather
    #: than only about what has been written. Falls back to the saved rows.
    members: list[MemberDraft] | None = None


def _service(request: Request) -> TeamService:
    return TeamService(get_db(request))


async def _thinker(request: Request, provider_id: str):
    """The endpoint to think with, plus the tools this machine can run.

    Offering a model `web_search` on a machine with no search key produces a
    team whose main tool is missing (§16.5) — the same rule
    `POST /agents/generate` follows, for the same reason.
    """
    db = get_db(request)
    async with db.session() as s:
        profile_row = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.id == provider_id)
            )
        ).scalar_one_or_none()
        if profile_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such provider profile")
        search_rows = (
            (
                await s.execute(
                    select(ProviderProfile).where(ProviderProfile.kind == "search")
                )
            )
            .scalars()
            .all()
        )

    has_search = any(secrets.has_key(p.id) for p in search_rows)
    offerable = [
        spec.id for spec in tool_registry.available(has_search_provider=has_search)
    ]
    try:
        provider = registry.build_from_profile(profile_row)
    except ProviderError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, exc.message) from exc
    return provider, profile_row, offerable


async def _roster(request: Request) -> list[Agent]:
    db = get_db(request)
    async with db.session() as s:
        rows = await s.execute(
            select(Agent).where(Agent.archived_at.is_(None)).order_by(Agent.name)
        )
        return list(rows.scalars().all())


@router.post("/teams/suggest")
async def suggest(request: Request, body: SuggestIn) -> dict[str, Any]:
    """Staff a team for a brief, from the agents that already exist.

    Saves nothing. The proposal is shown to be edited, exactly as a generated
    profile is (§11) and for the same reason: it is a suggestion about the
    user's own roster, and the user is the one who knows.

    What comes back is not "the model says this is a good team" but "here is a
    team, and here is what the run gate says about it" — see the module
    docstring for why those are different sentences.
    """
    agents = await _roster(request)
    if not agents:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "there are no agents to build a team from — create one first",
        )

    provider, profile_row, offerable = await _thinker(request, body.provider_id)
    try:
        result = await suggest_team(
            provider=provider,
            caps=registry.capabilities_for(profile_row),
            model=profile_row.model,
            brief=body.brief,
            agents=agents,
            available_tools=offerable,
        )
    except TeamGenerationFailed as exc:
        # Every attempt, not just the last. "It failed" is not something the
        # user can act on; "it kept seating somebody who does not exist" is.
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            {
                "message": "the model could not produce a usable team",
                "attempts": exc.attempts,
            },
        ) from exc
    except ProviderError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    finally:
        await provider.aclose()

    proposal = result.proposal
    by_id = {agent.id: agent for agent in agents}
    findings = validate(
        layout_id=proposal.layout_id,
        members=_trial_members(proposal, by_id),
        agents=by_id,
        known_tools=set(tool_registry.BY_ID),
    )

    return {
        "proposal": {
            "layoutId": proposal.layout_id,
            "members": [
                {
                    "agentId": m.agent_id,
                    "seat": m.seat,
                    "role": m.role,
                    "addTools": m.add_tools,
                    "why": m.why,
                }
                for m in proposal.members
            ],
            "gaps": [g.model_dump() for g in proposal.gaps],
        },
        # The run gate's verdict on what the model proposed. Never the model's
        # verdict on itself.
        "findings": [f.to_json() for f in findings],
        "canRun": can_run(findings),
        "attempts": result.attempts,
        "recoveredFrom": result.recovered_from,
        "usage": result.usage.to_event_usage(),
    }


def _trial_members(proposal, by_id: dict[str, Agent]) -> list[TeamMember]:
    """The proposal as rows the validator can read.

    Built with the tools each member would carry *after* the additions, because
    that is the team the user would be launching. Validating the agents as they
    stand today would report missing tools the proposal already fixes, and miss
    the ones it creates — `leader_only_tool` fires on exactly this: a tool the
    model decided to add, to the wrong person.
    """
    rows = []
    for index, member in enumerate(proposal.members):
        agent = by_id[member.agent_id]
        rows.append(
            TeamMember(
                team_id="proposed",
                agent_id=member.agent_id,
                seat_index=member.seat,
                role_in_team="leader" if member.role == "leader" else "member",
                overrides=(
                    {"tool_subset": sorted(set(agent.tools) | set(member.add_tools))}
                    if member.add_tools
                    else None
                ),
            )
        )
    return rows


@router.post("/teams/{team_id}/review")
async def review(request: Request, team_id: str, body: ReviewIn) -> dict[str, Any]:
    """Read a team against a piece of work.

    Advisory, and labelled so. It returns remarks and never a severity: a
    `warn` from a model would land in the same list as a `warn` from
    `validator.py` and be read as the same kind of claim. They are not.

    The deterministic findings come back beside it, from the same `validate()`
    the launch gate uses, under their own key.
    """
    service = _service(request)
    try:
        team = await service.get(team_id)
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc

    agents = {agent.id: agent for agent in await _roster(request)}
    members = (
        await service.members(team_id)
        if body.members is None
        else [
            TeamMember(
                team_id=team_id,
                agent_id=m.agent_id,
                seat_index=m.seat_index,
                role_in_team=m.role_in_team,
                overrides=m.overrides,
            )
            for index, m in enumerate(body.members)
        ]
    )

    described = [
        (
            agents[m.agent_id],
            "leader" if m.role_in_team == "leader" else "worker",
            _effective_tools(m, agents.get(m.agent_id)),
        )
        for m in members
        if m.agent_id in agents
    ]
    if not described:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "this team has nobody on it to read"
        )

    provider, profile_row, offerable = await _thinker(request, body.provider_id)
    try:
        result = await review_team(
            provider=provider,
            caps=registry.capabilities_for(profile_row),
            model=profile_row.model,
            brief=body.brief,
            members=described,
            available_tools=offerable,
        )
    except TeamGenerationFailed as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            {
                "message": "the model could not produce a usable answer",
                "attempts": exc.attempts,
            },
        ) from exc
    except ProviderError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    finally:
        await provider.aclose()

    findings = validate(
        layout_id=team.scene_layout_id,
        members=members,
        agents=agents,
        known_tools=set(tool_registry.BY_ID),
    )
    return {
        "verdict": result.review.verdict,
        "notes": [n.model_dump() for n in result.review.notes],
        # Separate keys, all the way to the screen. What a rule established and
        # what a model thinks are two different claims (§2.1, §5.2).
        "findings": [f.to_json() for f in findings],
        "canRun": can_run(findings),
        "attempts": result.attempts,
        "recoveredFrom": result.recovered_from,
        "usage": result.usage.to_event_usage(),
    }
