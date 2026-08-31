"""Async SQLite engine.

Async rather than sync because the bus persists inside its writer lock while a
token stream is in flight — a blocking write there would stall every other
connection. M4 runs agents in parallel, which makes that worse, not better.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .models import Base


def _apply_pragmas(dbapi_conn, _record) -> None:
    """SQLite defaults that are wrong for us, set on every connection.

    `foreign_keys` is OFF by default in SQLite — declared foreign keys are inert
    until you turn it on, which is a classic way to discover in production that
    nothing was ever enforced.
    """
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


class Database:
    """Owns the engine. Tests build one against a temp file or :memory:."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.engine: AsyncEngine = create_async_engine(url, future=True)
        event.listen(self.engine.sync_engine, "connect", _apply_pragmas)
        self.session_factory = async_sessionmaker(
            self.engine, expire_on_commit=False, class_=AsyncSession
        )

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.session_factory() as s:
            yield s

    async def create_all(self) -> None:
        """Tests only. Production schema comes from Alembic so that the
        migration path is the one actually exercised."""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def healthcheck(self) -> bool:
        async with self.engine.connect() as conn:
            return (await conn.execute(text("SELECT 1"))).scalar() == 1

    async def dispose(self) -> None:
        await self.engine.dispose()
