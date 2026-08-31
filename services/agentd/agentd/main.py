"""FastAPI application assembly.

Everything here is loopback-only and token-gated. The backend holds the user's
provider keys, so an open port on this machine is an open wallet (§9.1).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .core import auth
from .core.config import Settings, get_settings
from .core.events import EventBus
from .db.session import Database


async def require_token(
    x_agent_studio_token: str | None = Header(default=None),
) -> None:
    """Guards every REST route. No exceptions, including /health.

    A health endpoint that answered without a token would let any page on the
    machine fingerprint the app and learn the port to attack.
    """
    if not auth.is_valid(x_agent_studio_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid session token",
        )


def create_app(*, settings: Settings | None = None, db: Database | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        owned = db is None
        database = db or Database(settings.db_url)
        app.state.settings = settings
        app.state.db = database
        app.state.bus = EventBus(database)
        try:
            yield
        finally:
            if owned:
                await database.dispose()

    app = FastAPI(
        title="Agent Studio backend",
        version="0.1.0",
        lifespan=lifespan,
        # No docs endpoints: they are another unauthenticated surface on a
        # server that holds credentials, and nothing here consumes them.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/health", dependencies=[Depends(require_token)])
    async def health() -> dict[str, Any]:
        return {"ok": await app.state.db.healthcheck(), "version": app.version}

    return app


app = create_app()
