"""Starting and stopping missions (PROJECT_BRIEF.md §7.3).

`POST /missions` answers 202 with an id and nothing else. The reply itself
arrives over the WebSocket, because the event stream is the only way anything
leaves the backend (§2.1). Returning the text here would create a second
channel that the timeline and the scene never see — the exact shape of bug the
whole event-driven constraint exists to prevent.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db.models import Mission, ProviderProfile
from .deps import get_db, get_runner, require_token

router = APIRouter(dependencies=[Depends(require_token)])


class BudgetIn(BaseModel):
    max_llm_calls: int | None = Field(default=None, ge=1)
    max_supersteps: int | None = Field(default=None, ge=1)
    max_tokens: int | None = Field(default=None, ge=1)
    timeout_sec: int | None = Field(default=None, ge=1)


class MissionIn(BaseModel):
    kind: Literal["chat"] = "chat"  # 'mission' arrives with the orchestrator in M4
    provider_id: str
    content: str = Field(min_length=1)
    system: str | None = None
    budget: BudgetIn | None = None


@router.post("/missions", status_code=status.HTTP_202_ACCEPTED)
async def start_mission(request: Request, body: MissionIn) -> dict[str, Any]:
    db = get_db(request)
    async with db.session() as s:
        profile = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.id == body.provider_id)
            )
        ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such provider profile")

    runner = get_runner(request)
    mission_id = await runner.start_chat(
        profile=profile,
        content=body.content,
        system=body.system,
        budget=body.budget.model_dump(exclude_none=True) if body.budget else None,
    )
    # The client subscribes with since_seq=0 to catch the events already
    # published by the time this response lands.
    return {"missionId": mission_id, "sinceSeq": 0}


@router.post("/missions/{mission_id}/cancel")
async def cancel_mission(request: Request, mission_id: str) -> dict[str, Any]:
    """Stop a run in flight. In M1 because chat is a mission: the user must be
    able to stop a stream from the very first milestone (§15 row 9)."""
    runner = get_runner(request)
    cancelled = await runner.cancel(mission_id)
    if not cancelled:
        db = get_db(request)
        async with db.session() as s:
            mission = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
        if mission is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")
    return {"missionId": mission_id, "cancelled": cancelled}


@router.get("/missions/{mission_id}")
async def get_mission(request: Request, mission_id: str) -> dict[str, Any]:
    db = get_db(request)
    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
    if mission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")
    return {
        "id": mission.id,
        "kind": mission.kind,
        "teamId": mission.team_id,
        "goal": mission.goal,
        "status": mission.status,
        "budget": mission.budget,
        "rosterSnapshot": mission.roster_snapshot,
        "startedAt": mission.started_at.isoformat(),
        "endedAt": mission.ended_at.isoformat() if mission.ended_at else None,
        "endReason": mission.end_reason,
        "resultSummary": mission.result_summary,
        "running": get_runner(request).is_running(mission_id),
    }
