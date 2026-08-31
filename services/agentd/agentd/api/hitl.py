"""Answering a waiting mission, and reading what one produced (§7.3, §12 M6)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..agents.runner import RequestNotFound
from ..artifacts.store import ArtifactRejected, ArtifactStore, to_json
from ..db.models import Mission
from .deps import get_db, get_runner, require_token

router = APIRouter(dependencies=[Depends(require_token)])


class ResolveIn(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)


@router.get("/requests/pending")
async def pending_requests(request: Request) -> dict[str, Any]:
    """Everything waiting on the user, across every mission.

    A frontend that has just started has no idea what was asked before it
    existed — the question is an event from an earlier session. Without this,
    reopening the app would leave a paused mission stranded with nobody aware
    of it (§12 M6).
    """
    return {"requests": await get_runner(request).pending_requests()}


@router.post("/requests/{request_id}/resolve")
async def resolve_request(
    request: Request, request_id: str, body: ResolveIn
) -> dict[str, Any]:
    try:
        mission_id = await get_runner(request).resolve_request(request_id, body.answer)
    except RequestNotFound as exc:
        # 409 rather than 404: the request existed, it is simply no longer
        # outstanding — already answered, or its mission ended.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "no mission is waiting on this request; it may already be answered",
        ) from exc
    return {"missionId": mission_id, "resumed": True}


@router.get("/missions")
async def list_missions(request: Request, limit: int = 50) -> dict[str, Any]:
    """The mission history, for reopening an old run (§12 M6)."""
    db = get_db(request)
    async with db.session() as s:
        rows = await s.execute(
            select(Mission).order_by(Mission.started_at.desc()).limit(limit)
        )
        missions = list(rows.scalars().all())

    runner = get_runner(request)
    return {
        "missions": [
            {
                "id": m.id,
                "kind": m.kind,
                "goal": m.goal,
                "status": m.status,
                "endReason": m.end_reason,
                "startedAt": m.started_at.isoformat(),
                "endedAt": m.ended_at.isoformat() if m.ended_at else None,
                "pendingRequest": m.pending_request,
                "memberCount": len(m.roster_snapshot or []),
                "running": runner.is_running(m.id),
            }
            for m in missions
        ]
    }


@router.get("/missions/{mission_id}/events")
async def mission_events(request: Request, mission_id: str) -> dict[str, Any]:
    """Every event of a mission, in order — the replay source.

    Read straight off the append-only table, so replaying an old run shows
    exactly what was recorded at the time: the same events, in the same order,
    with the roster that was frozen at launch (§5.1).
    """
    bus = request.app.state.bus
    events = await bus.history(mission_id, 0, 10**9)
    if not events:
        db = get_db(request)
        async with db.session() as s:
            exists = (
                await s.execute(select(Mission.id).where(Mission.id == mission_id))
            ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")
    return {"events": events}


@router.get("/missions/{mission_id}/artifacts")
async def mission_artifacts(request: Request, mission_id: str) -> dict[str, Any]:
    store = ArtifactStore(get_db(request))
    return {"artifacts": [to_json(a) for a in await store.for_mission(mission_id)]}


@router.get("/artifacts/{artifact_id}")
async def read_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
    store = ArtifactStore(get_db(request))
    artifact = await store.get(artifact_id)
    if artifact is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such artifact")
    try:
        text = await store.read_text(artifact)
    except ArtifactRejected as exc:
        # The row can outlive the file if the data directory was cleaned. Said
        # plainly rather than as a 500.
        raise HTTPException(status.HTTP_410_GONE, str(exc)) from exc
    return {**to_json(artifact), "text": text}
