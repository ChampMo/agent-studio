"""FastAPI application assembly.

Everything here is loopback-only and token-gated. The backend holds the user's
provider keys, so an open port on this machine is an open wallet (§9.1).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from .agents.runner import MissionRunner
from .api import (
    agents,
    chat,
    hitl,
    settings as settings_api,
    teams,
    tools,
    ws,
)
from .api.deps import require_token
from .core.config import ALLOWED_ORIGINS, Settings, get_settings
from .core.events import EventBus
from .db.session import Database

log = logging.getLogger("agentd")


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
        # One saver for the process, backed by its own file. A mission paused
        # on a person has to be resumable by a *later* process, so the pause
        # cannot live in memory (brief section 12, M6).
        async with AsyncSqliteSaver.from_conn_string(
            str(settings.data_dir / "checkpoints.db")
        ) as checkpointer:
            runner = MissionRunner(database, bus, checkpointer=checkpointer)
            app.state.runner = runner

            # Before anything can read the table: a mission left `running` by a
            # process that no longer exists is not running, and saying otherwise
            # is the timeline lying about the present rather than the past.
            reaped = await runner.reap_orphans()
            if reaped:
                log.warning(
                    "closed %d mission(s) orphaned by a previous process", reaped
                )

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

    # The frontend is served from another port in dev and another scheme under
    # Tauri, so the browser needs this to let the page read a response. It is
    # not what keeps callers out — the token is (§9.1) — so the origin list is
    # explicit rather than "*", and credentials stay off: the token travels in a
    # header, never a cookie, so there is nothing for a browser to attach
    # automatically to a cross-site request.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(ALLOWED_ORIGINS),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"],
        allow_headers=["Content-Type", "X-Agent-Studio-Token"],
    )

    @app.get("/health", dependencies=[Depends(require_token)])
    async def health() -> dict[str, Any]:
        return {"ok": await app.state.db.healthcheck(), "version": app.version}

    app.include_router(agents.router)
    app.include_router(teams.router)
    app.include_router(settings_api.router)
    app.include_router(chat.router)
    app.include_router(hitl.router)
    app.include_router(tools.router)
    app.include_router(ws.router)
    return app


app = create_app()
