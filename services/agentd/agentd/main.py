"""FastAPI application assembly.

Everything here is loopback-only and token-gated. The backend holds the user's
provider keys, so an open port on this machine is an open wallet (§9.1).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI

from .agents.runner import MissionRunner
from .api import chat, settings as settings_api, tools, ws
from .api.deps import require_token
from .core.config import Settings, get_settings
from .core.events import EventBus
from .db.session import Database


def create_app(*, settings: Settings | None = None, db: Database | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        owned = db is None
        database = db or Database(settings.db_url)
        bus = EventBus(database)
        app.state.settings = settings
        app.state.db = database
        app.state.bus = bus
        app.state.runner = MissionRunner(database, bus)
        try:
            yield
        finally:
            if owned:
                await database.dispose()

    app = FastAPI(
        title="Agent Studio backend",
        version="0.1.0",
        lifespan=lifespan,
        # No docs endpoints: another unauthenticated surface on a server that
        # holds credentials, and nothing here consumes them.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/health", dependencies=[Depends(require_token)])
    async def health() -> dict[str, Any]:
        return {"ok": await app.state.db.healthcheck(), "version": app.version}

    app.include_router(settings_api.router)
    app.include_router(chat.router)
    app.include_router(tools.router)
    app.include_router(ws.router)
    return app


app = create_app()
