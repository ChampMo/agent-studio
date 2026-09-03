"""FastAPI application assembly.

Everything here is loopback-only and token-gated. The backend holds the user's
provider keys, so an open port on this machine is an open wallet (§9.1).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from .agents.runner import MissionRunner
from .api import (
    agents,
    chat,
    hitl,
    settings as settings_api,
    team_ai,
    teams,
    terminal,
    tools,
    ws,
)
from .api.deps import require_token
from .core.config import Settings, allowed_origins, get_settings
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

    # Added *before* CORS, which makes it the inner of the two: a response it
    # produces still travels back out through the CORS middleware.
    #
    # Without it an unhandled exception is caught by Starlette's outermost
    # error middleware instead, above CORS, so the 500 arrives with no
    # `Access-Control-Allow-Origin` header — and a browser reports that as a
    # CORS policy violation. That points at the one thing which is not wrong.
    # A database constraint failure cost two rounds of debugging today for
    # exactly this reason.
    @app.middleware("http")
    async def report_crashes(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception:  # noqa: BLE001 - the alternative is a silent 500
            # The traceback goes to the log, where it belongs. A stack trace in
            # an HTTP body hands internals to whatever provoked the error.
            log.exception("unhandled error on %s %s", request.method, request.url.path)
            return JSONResponse(
                status_code=500,
                content={"detail": "the backend hit an unexpected error; see its log"},
            )

    # The frontend is served from another port in dev and another scheme under
    # Tauri, so the browser needs this to let the page read a response. It is
    # not what keeps callers out — the token is (§9.1) — so the origin list is
    # explicit rather than "*", and credentials stay off: the token travels in a
    # header, never a cookie, so there is nothing for a browser to attach
    # automatically to a cross-site request.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(allowed_origins()),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"],
        allow_headers=["Content-Type", "X-Agent-Studio-Token"],
    )

    @app.get("/health", dependencies=[Depends(require_token)])
    async def health() -> dict[str, Any]:
        return {"ok": await app.state.db.healthcheck(), "version": app.version}

    app.include_router(agents.router)
    app.include_router(teams.router)
    app.include_router(team_ai.router)
    app.include_router(settings_api.router)
    app.include_router(chat.router)
    app.include_router(hitl.router)
    app.include_router(tools.router)
    app.include_router(terminal.router)
    app.include_router(ws.router)
    return app


app = create_app()
