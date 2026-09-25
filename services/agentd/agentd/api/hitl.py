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


def _mission_row(m: Mission, running: bool) -> dict[str, Any]:
    return {
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
        "running": running,
    }


async def _readable_missions(db, limit: int) -> tuple[list[Mission], int]:
    """Every mission the database can still describe, newest first.

    The ordinary read is one query, and it is all-or-nothing: SQLAlchemy builds
    every row before handing any of them back, so a single value the column's
    type cannot parse raises out of `execute()` itself. The row never reaches
    application code, which is why guarding the thing that formats a row is no
    guard at all.

    A database that cannot answer that query is read one row at a time instead,
    so one bad row costs one entry rather than all of them. The ordering stays
    in SQL, where a corrupt timestamp is only a string to sort, and the ids come
    back because `Mission.id` is text — the ids survive even when the rows they
    name do not.

    Only the data-shaped errors are caught. An `AttributeError` here is our bug
    and should still be a 500: degrading quietly to "every row is unreadable"
    would be a worse lie than the crash.
    """
    newest_first = Mission.started_at.desc()
    async with db.session() as s:
        try:
            rows = await s.execute(select(Mission).order_by(newest_first).limit(limit))
            return list(rows.scalars().all()), 0
        except (ValueError, TypeError):
            # No rollback: the statement ran and the failure is Python-side, in
            # the row the driver's own bytes are turned into. Rolling back here
            # would expire every instance this session goes on to load.
            pass

        ids = (
            await s.execute(select(Mission.id).order_by(newest_first).limit(limit))
        ).scalars().all()

        readable: list[Mission] = []
        unreadable = 0
        for mission_id in ids:
            try:
                row = (
                    await s.execute(select(Mission).where(Mission.id == mission_id))
                ).scalar_one_or_none()
            except (ValueError, TypeError):
                unreadable += 1
                continue
            if row is not None:
                readable.append(row)
        return readable, unreadable


@router.get("/missions")
async def list_missions(request: Request, limit: int = 50) -> dict[str, Any]:
    """The mission history, for reopening an old run (§12 M6).

    **One unreadable row must not take the whole list with it.** A corrupted
    database left a mission whose `started_at`, `title` and `end_reason` were
    NUL bytes, `GET /missions` answered 500, and the sidebar went completely
    empty over a database holding five perfectly good runs — including the one
    the person had started a minute earlier and was asking about. Every run was
    invisible because of one that was not.

    So a row that cannot be read is left out and counted. `unreadable` is on the
    response rather than swallowed, because a list quietly missing an entry is
    the app being untrue about what it holds (§1) — and the number is the only
    clue anybody gets that a database wants looking at.

    Same rule `get_app_budget` already follows: a corrupt row falls back rather
    than taking the others down with it.
    """
    missions, unreadable = await _readable_missions(get_db(request), limit)

    runner = get_runner(request)
    described: list[dict[str, Any]] = []
    for m in missions:
        try:
            described.append(_mission_row(m, runner.is_running(m.id)))
        except (ValueError, TypeError):
            # A row SQLAlchemy could build and this cannot describe: a
            # `roster_snapshot` holding something that is not a list, say.
            unreadable += 1

    return {"missions": described, "unreadable": unreadable}


class RenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.patch("/missions/{mission_id}")
async def rename_mission(
    request: Request, mission_id: str, body: RenameIn
) -> dict[str, Any]:
    """Change what a run is called. Only that.

    `missions.title` and `missions.goal` were split apart in migration 0010
    precisely because they are different things: the goal is *what the team was
    asked to do*, which is a record and must never be edited, and the title is
    *what you call it in the list*, which is a label and was always yours.

    So this endpoint takes a title and nothing else. There is no field here for
    the goal, and there should not be one — a run whose instruction could be
    rewritten afterwards would make every replay unverifiable against the thing
    it was actually asked (§5.1).

    Runs recorded before 0010 have no title and are listed by their goal. Naming
    one of those writes a title for the first time; the goal underneath is
    untouched, so what it was asked is still exactly what the log says.
    """
    db = get_db(request)
    async with db.session() as session:
        mission = (
            await session.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
        if mission is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")
        mission.title = body.title.strip()
        await session.commit()
        return {"id": mission.id, "title": mission.title}


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
