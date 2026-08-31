"""Tool registry.

Served by the backend rather than shared as a second contract file: the event
schema is the only thing both sides must keep in sync (§2.2, §15 row 11). The
frontend asks what tools exist instead of shipping its own copy of the list.

M1 has no tools — sandboxed execution arrives with the orchestrator. The
endpoint exists now so the frontend never has to special-case its absence.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from .deps import require_token

router = APIRouter(dependencies=[Depends(require_token)])


@router.get("/tools")
async def list_tools() -> dict[str, Any]:
    return {"tools": []}
