"""Shared route dependencies."""

from __future__ import annotations

from fastapi import Header, HTTPException, Request, status

from ..agents.runner import MissionRunner
from ..core import auth
from ..core.events import EventBus
from ..db.session import Database


async def require_token(
    x_agent_studio_token: str | None = Header(default=None),
) -> None:
    """Guards every REST route, `/health` included.

    A health endpoint that answered without a token would let any page on this
    machine fingerprint the app and learn which port to attack (§9.1).
    """
    if not auth.is_valid(x_agent_studio_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid session token",
        )


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_bus(request: Request) -> EventBus:
    return request.app.state.bus


def get_runner(request: Request) -> MissionRunner:
    return request.app.state.runner
