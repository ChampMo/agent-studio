"""Starting and stopping missions (PROJECT_BRIEF.md §7.3).

`POST /missions` answers 202 with an id and nothing else. The reply itself
arrives over the WebSocket, because the event stream is the only way anything
leaves the backend (§2.1). Returning the text here would create a second
channel that the timeline and the scene never see — the exact shape of bug the
whole event-driven constraint exists to prevent.
"""

from __future__ import annotations

import base64
import binascii

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..attachments.store import AttachmentRejected, AttachmentStore
from ..db.models import Attachment
from ..agents.runner import (
    MissionAlreadyRunning,
    MissionNotRunning,
    MissionRejected,
    UnknownTeammate,
)
from ..artifacts.rewind import Rewinder
from ..tools.team import Ambiguous
from ..db.models import Mission, ProviderProfile
from .deps import get_bus, get_db, get_runner, require_token
from ..core.events import as_utc_iso
from ..core.prefs import validate_overrides

router = APIRouter(dependencies=[Depends(require_token)])


class BudgetIn(BaseModel):
    """One run's ceilings, any subset of them (§10).

    The bounds are not written here. `validate_overrides` owns what a legal
    limit is, and it is what a team's default goes through — a run and a team
    disagreeing about whether 500 tokens is allowed would be two tables of the
    same numbers, which is the drift that function exists to prevent.
    """

    max_llm_calls: int | None = None
    max_supersteps: int | None = None
    max_tokens: int | None = None
    timeout_sec: int | None = None


class MissionIn(BaseModel):
    kind: Literal["chat", "mission"] = "chat"
    #: chat only
    provider_id: str | None = None
    system: str | None = None
    #: mission only
    team_id: str | None = None
    #: Pause after planning and wait for the user before any work is paid for.
    require_approval: bool = False
    #: The folder this mission's file tools may touch (§16.2). Validated again
    #: on this side: it arrives from a window, and the window can be driven.
    workspace_root: str | None = Field(default=None, max_length=4096)
    #: What to call this run in the history list. Optional: a run started
    #: without one is listed by what it was asked to do.
    title: str | None = Field(default=None, max_length=200)
    content: str = Field(min_length=1)
    budget: BudgetIn | None = None


@router.post("/missions", status_code=status.HTTP_202_ACCEPTED)
async def start_mission(request: Request, body: MissionIn) -> dict[str, Any]:
    runner = get_runner(request)
    try:
        budget = validate_overrides(
            body.budget.model_dump(exclude_none=True) if body.budget else None
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    # An empty override set is *no* budget rather than an empty one, so
    # `resolve_limits` falls straight through to the team's and then the app's.
    budget = budget or None

    if body.kind == "mission":
        if not body.team_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "a team mission needs a team_id"
            )
        try:
            mission_id = await runner.start_mission(
                team_id=body.team_id,
                goal=body.content,
                title=body.title,
                budget=budget,
                require_approval=body.require_approval,
                workspace_root=body.workspace_root,
            )
        except MissionRejected as exc:
            # 409, not 400: the request is well-formed, the team is not ready.
            # Every blocking finding comes back, because fixing a team one
            # rejection at a time is a guessing game (§5.2).
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {"message": "this team cannot run", "problems": exc.problems},
            ) from exc
        return {"missionId": mission_id, "sinceSeq": 0}

    if not body.provider_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "a chat needs a provider_id")

    db = get_db(request)
    async with db.session() as s:
        profile = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.id == body.provider_id)
            )
        ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such provider profile")

    mission_id = await runner.start_chat(
        profile=profile,
        content=body.content,
        system=body.system,
        budget=budget,
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


class NoteIn(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    #: One teammate, by name or id. Absent means the whole team, which is what
    #: a note has always been — so nothing that already worked changes.
    to: str | None = None
    #: Show the plan before the work starts, for this round. Only meaningful on
    #: `continue`: `POST /missions` has its own flag.
    require_approval: bool = False


@router.post("/missions/{mission_id}/message", status_code=status.HTTP_202_ACCEPTED)
async def send_note(request: Request, mission_id: str, body: NoteIn) -> dict[str, Any]:
    """Say something to a team that is already working (§7.1).

    202, not 200, and the word matters: this is *accepted for delivery*, not
    acted on. Nothing can reach a model mid-reply, so the note waits in every
    member's mailbox and is collected when their next task starts. The UI says
    that in those words rather than "sent".
    """
    try:
        await get_runner(request).note(mission_id, body.content, to=body.to)
    except Ambiguous as exc:
        # Two teammates fit the name. Not resolved by picking one: delivering
        # to the wrong person and reporting success is the worst failure here,
        # and the person can settle it in one keystroke.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"message": f"more than one teammate matches '{exc.asked}'",
             "names": exc.names},
        ) from None
    except UnknownTeammate as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"message": f"nobody on this team is called '{exc.asked}'",
             "names": exc.names},
        ) from None
    except MissionNotRunning:
        # 409: the request is well-formed, the mission is simply not being
        # driven any more — usually it finished while the message was typed.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this mission is not running, so there is nobody to deliver to",
        ) from None
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return {"missionId": mission_id, "queued": True}


@router.post("/missions/{mission_id}/continue", status_code=status.HTTP_202_ACCEPTED)
async def continue_mission(
    request: Request, mission_id: str, body: NoteIn
) -> dict[str, Any]:
    """Keep going in the same conversation (§7.1).

    A round ending is not the mission ending. This reopens the row and runs the
    graph again over the roster the mission froze at launch, appending to the
    same log — so the workspace, the team and everything already on the
    timeline carry over, which is the whole point of asking for one more change
    rather than starting again.
    """
    runner = get_runner(request)
    try:
        await runner.continue_mission(
            mission_id, body.content, require_approval=body.require_approval
        )
    except MissionAlreadyRunning:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "this mission is still working"
        ) from None
    except MissionNotRunning:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "no such team mission to continue"
        ) from None
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return {"missionId": mission_id, "continued": True}


class ForkIn(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    title: str | None = Field(default=None, max_length=120)
    require_approval: bool = False


@router.post("/missions/{mission_id}/fork", status_code=status.HTTP_202_ACCEPTED)
async def fork_mission(
    request: Request, mission_id: str, body: ForkIn
) -> dict[str, Any]:
    """Try it again, differently, without losing this one.

    Continuing appends to the same conversation and cannot be taken back;
    starting fresh forgets the team and the workspace. Between those two there
    was nothing, and "run that again but let the designer do it" is an ordinary
    thing to want.

    The new run gets the parent's **frozen roster verbatim**, its workspace and
    its limits. Copied rather than re-resolved: the point of a fork is to
    compare two attempts, and re-reading the agents table would let them differ
    in ways neither record mentions (§5.1).
    """
    try:
        new_id = await get_runner(request).fork_mission(
            mission_id,
            body.content,
            title=body.title,
            require_approval=body.require_approval,
        )
    except MissionNotRunning:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "no such team mission to fork"
        ) from None
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return {"missionId": new_id, "forkedFrom": mission_id}


class RewindIn(BaseModel):
    #: The event to go back to. A sequence number, because that is how the log
    #: is addressed everywhere else in this app.
    seq: int = Field(ge=0)


@router.get("/missions/{mission_id}/rewind")
async def rewind_plan(request: Request, mission_id: str, seq: int) -> dict[str, Any]:
    """What a rewind would do, before it does any of it.

    Shown first on purpose. This can only restore what `write_file` and
    `edit_file` wrote — a file `bash` created or moved has no stored version —
    so the honest thing is to name the files it will touch and the ones it
    cannot, and let the person decide with that in front of them rather than
    discover it afterwards.
    """
    plan = await Rewinder(get_db(request)).plan(mission_id=mission_id, seq=seq)
    return plan.to_json()


@router.post("/missions/{mission_id}/rewind")
async def rewind(request: Request, mission_id: str, body: RewindIn) -> dict[str, Any]:
    """Put the files back the way they were at that point.

    Refused while the mission is running: rewriting files under a team that is
    reading them produces a workspace neither the agents nor the record can
    account for. Stop it first, which is one click and says what it is.
    """
    runner = get_runner(request)
    if runner.is_running(mission_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "stop the run before rewinding — the team is using these files",
        )
    db = get_db(request)
    async with db.session() as s:
        mission = (
            await s.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
    if mission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")
    if not mission.workspace_root:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "this run had no workspace, so there is nothing to put back"
        )
    return await Rewinder(db).apply(
        mission_id=mission_id, seq=body.seq, workspace_root=mission.workspace_root
    )


class AttachmentIn(BaseModel):
    """One image, base64 as the browser read it."""

    name: str = Field(min_length=1, max_length=200)
    mime: str = Field(min_length=1, max_length=100)
    data_b64: str = Field(min_length=1)


@router.post("/missions/{mission_id}/attachments", status_code=status.HTTP_201_CREATED)
async def add_attachment(
    request: Request, mission_id: str, body: AttachmentIn
) -> dict[str, Any]:
    """Attach an image to this run (§12 M9.3).

    Every agent on the next round sees it. The bytes go to disk,
    content-addressed; the event carries the name, size, type and digest, and
    not the picture — `mission_events` is append-only forever and a few
    screenshots inlined would make it unbounded (§9.3).
    """
    try:
        data = base64.b64decode(body.data_b64, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "the image data was not valid base64"
        ) from None

    store = AttachmentStore(get_db(request))
    try:
        row = await store.add(
            mission_id=mission_id, name=body.name, mime=body.mime, data=data
        )
    except AttachmentRejected as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None

    await get_bus(request).publish(
        mission_id,
        {
            "type": "attachment.added",
            "payload": {
                "attachmentId": row.id,
                "name": row.name,
                "bytes": row.bytes,
                "mime": row.mime,
                "sha256": row.sha256,
            },
        },
    )
    return {
        "attachmentId": row.id,
        "name": row.name,
        "bytes": row.bytes,
        "mime": row.mime,
    }


@router.get("/attachments/{attachment_id}")
async def read_attachment(request: Request, attachment_id: str) -> Response:
    """The image itself, so the transcript can show what was sent."""
    db = get_db(request)
    async with db.session() as s:
        row = (
            await s.execute(select(Attachment).where(Attachment.id == attachment_id))
        ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such attachment")
    try:
        data = AttachmentStore(db).read(row)
    except AttachmentRejected:
        # 410, not 404: the record exists and the bytes do not, which is a
        # different thing to tell someone (§12 M6).
        raise HTTPException(status.HTTP_410_GONE, "the stored file is gone") from None
    return Response(content=data, media_type=row.mime)


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
        "title": mission.title,
        "goal": mission.goal,
        "status": mission.status,
        "budget": mission.budget,
        "rosterSnapshot": mission.roster_snapshot,
        #: Shown for as long as the mission runs: an agent writing files
        #: somewhere the user cannot see is what §1 rules out (§16.2).
        "workspaceRoot": mission.workspace_root,
        "startedAt": as_utc_iso(mission.started_at),
        "endedAt": as_utc_iso(mission.ended_at),
        "endReason": mission.end_reason,
        "endLimit": mission.end_limit,
        "tasksDone": mission.tasks_done,
        "tasksTotal": mission.tasks_total,
        "resultSummary": mission.result_summary,
        "running": get_runner(request).is_running(mission_id),
    }
