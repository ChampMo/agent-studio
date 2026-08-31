from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest_asyncio

from agentd.core.events import EventBus
from agentd.db.migrate import upgrade_to_head
from agentd.db.models import Mission
from agentd.db.session import Database


@pytest_asyncio.fixture
async def db(tmp_path) -> AsyncIterator[Database]:
    """A real migrated database, not metadata.create_all().

    Tests run the same migration path production runs, so a migration that is
    broken fails here rather than on a user's machine.
    """
    url = f"sqlite+aiosqlite:///{(tmp_path / 'test.db').as_posix()}"
    # Alembic's async env.py calls asyncio.run(), which refuses to nest inside
    # the loop pytest-asyncio is already running. A worker thread gives it the
    # fresh loop it expects.
    await asyncio.to_thread(upgrade_to_head, url)
    database = Database(url)
    try:
        yield database
    finally:
        await database.dispose()


@pytest_asyncio.fixture
async def bus(db: Database) -> EventBus:
    return EventBus(db)


@pytest_asyncio.fixture
async def mission_id(db: Database) -> str:
    """mission_events has a real foreign key, and PRAGMA foreign_keys is ON, so
    a parent row has to exist before anything can be published."""
    mid = "m-test"
    async with db.session() as s:
        s.add(
            Mission(
                id=mid,
                kind="chat",
                team_id=None,
                goal="test",
                status="running",
                budget={},
                roster_snapshot=[],
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()
    return mid


def draft(text: str) -> dict:
    return {"type": "agent.thought", "payload": {"agentId": "a1", "text": text}}
