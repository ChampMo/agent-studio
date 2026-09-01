"""Team CRUD, validation, export and import (PROJECT_BRIEF.md §5.2, §5.3)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..agents.avatar import InvalidAvatar
from ..teams import layouts
from ..teams.service import ImportRejected, TeamNotFound, TeamService
from ..teams.validator import blocking
from .deps import get_db, require_token

router = APIRouter(dependencies=[Depends(require_token)])


class MemberIn(BaseModel):
    agent_id: str
    seat_index: int = Field(ge=0)
    role_in_team: Literal["leader", "member"] = "member"
    overrides: dict[str, Any] | None = None


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    emblem_config: dict[str, Any] = Field(default_factory=dict)
    scene_layout_id: str = layouts.DEFAULT_LAYOUT
    default_budget: dict[str, Any] = Field(default_factory=dict)
    members: list[MemberIn] = Field(default_factory=list)


class TeamPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = None
    emblem_config: dict[str, Any] | None = None
    scene_layout_id: str | None = None
    default_budget: dict[str, Any] | None = None
    members: list[MemberIn] | None = None


def _service(request: Request) -> TeamService:
    return TeamService(get_db(request))


@router.get("/scene-layouts")
async def scene_layouts() -> dict[str, Any]:
    return {"layouts": layouts.catalogue(), "default": layouts.DEFAULT_LAYOUT}


@router.get("/teams")
async def list_teams(request: Request, include_archived: bool = False) -> dict[str, Any]:
    service = _service(request)
    teams = await service.list(include_archived=include_archived)
    return {"teams": [await service.to_json(t) for t in teams]}


@router.get("/teams/{team_id}")
async def get_team(request: Request, team_id: str) -> dict[str, Any]:
    service = _service(request)
    try:
        return await service.to_json(await service.get(team_id))
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc


@router.post("/teams", status_code=status.HTTP_201_CREATED)
async def create_team(request: Request, body: TeamIn) -> dict[str, Any]:
    """Saving accepts an incomplete team on purpose.

    §5.2: save warns, run blocks. A half-built team is a normal state to be in
    while building one, and refusing to save it would mean losing the work.
    The findings come back in the response so the builder can show them inline.
    """
    service = _service(request)
    payload = body.model_dump()
    payload["members"] = [m.model_dump() for m in body.members]
    team = await service.create(payload)
    return await service.to_json(team)


@router.patch("/teams/{team_id}")
async def update_team(request: Request, team_id: str, body: TeamPatch) -> dict[str, Any]:
    service = _service(request)
    changes = body.model_dump(exclude_unset=True)
    if body.members is not None:
        changes["members"] = [m.model_dump() for m in body.members]
    try:
        return await service.to_json(await service.update(team_id, changes))
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc


@router.post("/teams/{team_id}/duplicate", status_code=status.HTTP_201_CREATED)
async def duplicate_team(request: Request, team_id: str) -> dict[str, Any]:
    service = _service(request)
    try:
        return await service.to_json(await service.duplicate(team_id))
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc


@router.delete("/teams/{team_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
async def delete_team(request: Request, team_id: str) -> None:
    """Really delete. Archiving stays on the plain DELETE, because it is the
    one that can be taken back."""
    try:
        await _service(request).delete(team_id)
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc


@router.delete("/teams/{team_id}")
async def archive_team(request: Request, team_id: str) -> dict[str, Any]:
    service = _service(request)
    try:
        return await service.to_json(await service.archive(team_id))
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc


@router.post("/teams/{team_id}/restore")
async def restore_team(request: Request, team_id: str) -> dict[str, Any]:
    service = _service(request)
    try:
        return await service.to_json(await service.restore(team_id))
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc


@router.get("/teams/{team_id}/validate")
async def validate_team(request: Request, team_id: str) -> dict[str, Any]:
    """The same findings the run gate uses. There is no second check (§5.2)."""
    service = _service(request)
    try:
        findings = await service.validate(team_id)
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc
    return {
        "findings": [f.to_json() for f in findings],
        "canRun": not blocking(findings),
    }


@router.get("/teams/{team_id}/export")
async def export_team(request: Request, team_id: str) -> dict[str, Any]:
    service = _service(request)
    try:
        return await service.export(team_id)
    except TeamNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such team") from exc


@router.post("/teams/import", status_code=status.HTTP_201_CREATED)
async def import_team(request: Request, document: dict[str, Any]) -> dict[str, Any]:
    service = _service(request)
    source_id = (document.get("team") or {}).get("source_id")
    existing = await service.find_by_source(source_id) if source_id else []

    try:
        result = await service.import_(document)
    except ImportRejected as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except InvalidAvatar as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.problems) from exc

    return {
        **result,
        # New ids always, so nothing the user has edited is overwritten. The UI
        # uses this to say "you already imported this once" rather than leaving
        # them to wonder why there are two (§5.3).
        "alreadyImported": [t.id for t in existing],
        "team": await service.to_json(await service.get(result["team_id"])),
    }
