"""Tool registry, and the workspace a mission's file tools are confined to.

Served by the backend rather than shared as a second contract file: the event
schema is the only thing both sides must keep in sync (§2.2, §15 row 11). The
frontend asks what tools exist instead of shipping its own copy of the list.

The workspace endpoints live here because they answer the same question from the
other end — *where* may these tools run. Validation is on this side and only on
this side: the path arrives from a window, and a window can be driven (§16.2).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db.models import ProviderProfile
from ..core.secrets import has_key
from ..tools import registry
from ..tools.workspace import WorkspaceRejected, WorkspaceStore, check
from .deps import get_db, require_token

router = APIRouter(dependencies=[Depends(require_token)])


async def _has_search_provider(request: Request) -> bool:
    """Whether a search endpoint is configured *and* has a key.

    Both halves matter: a profile with no key cannot search, and a tool that is
    listed but always fails teaches a model to keep calling it (§15 row 32).
    """
    db = get_db(request)
    async with db.session() as session:
        rows = await session.execute(
            select(ProviderProfile).where(ProviderProfile.kind == "search")
        )
        return any(has_key(profile.id) for profile in rows.scalars().all())


@router.get("/tools")
async def list_tools(request: Request) -> dict[str, Any]:
    specs = registry.available(has_search_provider=await _has_search_provider(request))
    return {"tools": [spec.to_json() for spec in specs]}


class WorkspaceIn(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


@router.post("/workspaces/validate")
async def validate_workspace(body: WorkspaceIn) -> dict[str, Any]:
    """Resolve a chosen folder and say whether a mission may use it.

    Runs for a path typed by hand and for one picked from the recent list
    alike: having passed once is not a permission, and a folder can stop being
    a reasonable place to write between two launches (§16.2).
    """
    try:
        return check(body.path).to_json()
    except WorkspaceRejected as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, exc.reason) from exc


@router.get("/workspaces/recent")
async def recent_workspaces(request: Request) -> dict[str, Any]:
    return {"workspaces": await WorkspaceStore(get_db(request)).recent()}
