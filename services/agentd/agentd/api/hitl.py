"""Answering a waiting mission, and reading what one produced (§7.3, §12 M6)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ..agents.runner import RequestNotFound
from ..artifacts.store import ArtifactRejected, ArtifactStore, to_json
from ..artifacts.versions import VersionStore, to_json as version_json
from ..db.models import Artifact, Mission, MissionEvent
from .deps import get_db, get_runner, require_token
from ..core.events import as_utc_iso

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
                "title": m.title,
                "goal": m.goal,
                "status": m.status,
                "endReason": m.end_reason,
                "endLimit": m.end_limit,
                "tasksDone": m.tasks_done,
                "tasksTotal": m.tasks_total,
                "startedAt": as_utc_iso(m.started_at),
                "endedAt": as_utc_iso(m.ended_at),
                "pendingRequest": m.pending_request,
                "memberCount": len(m.roster_snapshot or []),
                "running": runner.is_running(m.id),
            }
            for m in missions
        ]
    }


@router.delete("/missions/{mission_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mission(request: Request, mission_id: str) -> None:
    """Delete a whole mission: its row, its events, its files.

    This is the one exception to "mission_events is append-only forever" (§2,
    §5), and it is worth being precise about what the rule protects. The rule
    exists so that nothing *rewrites* what happened — no UPDATE, no correcting
    a line after the fact, because a record that can be edited is not a record.
    Removing an entire run at the user's request does not rewrite anything: it
    is the difference between tearing a page out and altering it.

    So: whole missions only, never single events, and only when someone asks.
    A run that is still going is refused — cancel it first, so it ends with the
    `mission.ended` every mission is promised, rather than vanishing mid-flight.
    """
    runner = get_runner(request)
    if runner.is_running(mission_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this mission is still running; stop it before deleting it",
        )

    db = get_db(request)
    store = ArtifactStore(db)
    # The files first: a row deleted before its file is a file nothing points
    # at, which is worse than an orphaned row.
    for artifact in await store.for_mission(mission_id):
        await store.remove(artifact)

    async with db.session() as session:
        mission = (
            await session.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
        if mission is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")
        await session.execute(
            delete(MissionEvent).where(MissionEvent.mission_id == mission_id)
        )
        await session.execute(delete(Artifact).where(Artifact.mission_id == mission_id))
        await session.delete(mission)
        await session.commit()


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


@router.get("/missions/{mission_id}/file-versions")
async def file_versions(
    request: Request, mission_id: str, path: str
) -> dict[str, Any]:
    """Every version of one file in this run, oldest first.

    Oldest first because that is the order a diff walks: each version against
    the one before it, and the first against nothing, which is what "created"
    means.
    """
    store = VersionStore(get_db(request))
    rows = await store.for_file(mission_id, path)
    return {"versions": [version_json(row) for row in rows]}


@router.get("/file-versions/{version_id}")
async def read_file_version(request: Request, version_id: str) -> dict[str, Any]:
    store = VersionStore(get_db(request))
    row = await store.get(version_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such version")
    try:
        text = store.read_text(row)
    except FileNotFoundError as exc:
        # The row outlives the blob if the data folder was cleaned. Said
        # plainly rather than as a crash.
        raise HTTPException(status.HTTP_410_GONE, str(exc)) from exc
    return {**version_json(row), "text": text}


@router.get("/artifacts/{artifact_id}")
async def read_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
    store = ArtifactStore(get_db(request))
    artifact = await store.get(artifact_id)
    if artifact is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such artifact")
    # A workspace file lives in the folder the mission was given, and that
    # folder is the boundary it is resolved against (§16.2). Read from the
    # mission row rather than from anything the caller sent: the artifact id is
    # what was asked for, and where its file may be is not the caller's to say.
    workspace: str | None = None
    if artifact.source == "workspace":
        db = get_db(request)
        async with db.session() as session:
            mission = (
                await session.execute(
                    select(Mission).where(Mission.id == artifact.mission_id)
                )
            ).scalar_one_or_none()
        workspace = mission.workspace_root if mission else None
    try:
        text = await store.read_text(artifact, workspace)
    except ArtifactRejected as exc:
        # The row can outlive the file if the data directory was cleaned. Said
        # plainly rather than as a 500.
        raise HTTPException(status.HTTP_410_GONE, str(exc)) from exc
    return {**to_json(artifact), "text": text}
