"""Roster CRUD and AI profile generation (PROJECT_BRIEF.md §11)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..agents.avatar import InvalidAvatar, catalogue
from ..agents.profile_gen import ProfileGenerationFailed, generate_profile
from ..agents.service import AgentNotFound, AgentService, to_json
from ..db.models import ProviderProfile
from ..providers import registry
from ..providers.base import ProviderError
from .deps import get_db, require_token

router = APIRouter(dependencies=[Depends(require_token)])


class AgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    title: str = ""
    role: str = ""
    backstory: str = ""
    personality_traits: list[str] = Field(default_factory=list)
    system_prompt: str = ""
    provider_id: str | None = None
    model: str | None = None
    sampling: dict[str, Any] | None = None
    tools: list[str] = Field(default_factory=list)
    #: Defaults to the cautious value: an agent created without saying stops
    #: before `bash` and `web_fetch` rather than after (§16.4).
    autonomy: Literal["ask_always", "ask_dangerous", "trusted"] = "ask_dangerous"
    avatar_config: dict[str, str] | None = None


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    title: str | None = None
    role: str | None = None
    backstory: str | None = None
    personality_traits: list[str] | None = None
    system_prompt: str | None = None
    provider_id: str | None = None
    model: str | None = None
    sampling: dict[str, Any] | None = None
    tools: list[str] | None = None
    autonomy: Literal["ask_always", "ask_dangerous", "trusted"] | None = None
    avatar_config: dict[str, str] | None = None


class GenerateIn(BaseModel):
    provider_id: str
    role: str = Field(min_length=1, max_length=200)
    brief: str = Field(default="", max_length=2000)


def _service(request: Request) -> AgentService:
    return AgentService(get_db(request))


@router.get("/avatar-assets")
async def avatar_assets() -> dict[str, Any]:
    """The closed set an avatar may be assembled from (§11). Served rather than
    shared as a file, so there is still only one contract to keep in sync."""
    return {"slots": catalogue()}


@router.get("/agents")
async def list_agents(request: Request, include_archived: bool = False) -> dict[str, Any]:
    agents = await _service(request).list(include_archived=include_archived)
    return {"agents": [to_json(a) for a in agents]}


@router.get("/agents/{agent_id}")
async def get_agent(request: Request, agent_id: str) -> dict[str, Any]:
    try:
        return to_json(await _service(request).get(agent_id))
    except AgentNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such agent") from exc


@router.post("/agents", status_code=status.HTTP_201_CREATED)
async def create_agent(request: Request, body: AgentIn) -> dict[str, Any]:
    try:
        agent = await _service(request).create(body.model_dump(exclude_none=True))
    except InvalidAvatar as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.problems) from exc
    return to_json(agent)


@router.patch("/agents/{agent_id}")
async def update_agent(
    request: Request, agent_id: str, body: AgentPatch
) -> dict[str, Any]:
    changes = body.model_dump(exclude_unset=True)
    try:
        return to_json(await _service(request).update(agent_id, changes))
    except AgentNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such agent") from exc
    except InvalidAvatar as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.problems) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.post("/agents/{agent_id}/duplicate", status_code=status.HTTP_201_CREATED)
async def duplicate_agent(request: Request, agent_id: str) -> dict[str, Any]:
    try:
        return to_json(await _service(request).duplicate(agent_id))
    except AgentNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such agent") from exc


@router.delete("/agents/{agent_id}")
async def archive_agent(request: Request, agent_id: str) -> dict[str, Any]:
    """Archives rather than deletes. DELETE is the verb users reach for, but the
    row survives: teams and finished missions still point at it (§5.2)."""
    try:
        return to_json(await _service(request).archive(agent_id))
    except AgentNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such agent") from exc


@router.post("/agents/{agent_id}/restore")
async def restore_agent(request: Request, agent_id: str) -> dict[str, Any]:
    try:
        return to_json(await _service(request).restore(agent_id))
    except AgentNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such agent") from exc


@router.post("/agents/generate")
async def generate(request: Request, body: GenerateIn) -> dict[str, Any]:
    """Draft a profile. Returns it; saves nothing.

    §11 is explicit that the user edits before anything is written, so there is
    no `create=true` shortcut here — the only way into the table is POST /agents
    with fields the user has seen.
    """
    db = get_db(request)
    async with db.session() as s:
        profile_row = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.id == body.provider_id)
            )
        ).scalar_one_or_none()
    if profile_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such provider profile")

    try:
        provider = registry.build_from_profile(profile_row)
    except ProviderError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, exc.message) from exc

    try:
        result = await generate_profile(
            provider=provider,
            caps=registry.capabilities_for(profile_row),
            model=profile_row.model,
            role=body.role,
            brief=body.brief,
        )
    except ProfileGenerationFailed as exc:
        # Every attempt is returned, not just the last. "It failed" is not
        # something the user can act on; "it kept inventing hair styles" is.
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            {"message": "the model could not produce a usable profile", "attempts": exc.attempts},
        ) from exc
    except ProviderError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    finally:
        await provider.aclose()

    return {
        "profile": result.profile.model_dump(),
        "attempts": result.attempts,
        # Surfaced so the UI can say the model needed correcting. A profile that
        # took three tries is a fact about the chosen model (§1).
        "recoveredFrom": result.recovered_from,
        "usage": result.usage.to_event_usage(),
    }
