"""One unreadable row must not empty the whole sidebar.

A corrupted database left a mission whose `started_at`, `title` and
`end_reason` were NUL bytes. `as_utc_iso` cannot parse a NUL string, so
building the list raised, `GET /missions` answered 500, and the sidebar went
**completely empty** over a database holding five perfectly good runs —
including the one the person had started thirty seconds earlier and was asking
about. Every run was invisible because of one that was not.

The same rule `get_app_budget` already follows: a corrupt row falls back rather
than taking the others down with it.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from agentd.core import auth, config
from agentd.db.models import Mission
from agentd.db.session import Database
from agentd.main import create_app

TOKEN = "test-token"

#: Built rather than written as a literal: a source file holding a real NUL
#: byte cannot be parsed, which is a small demonstration of the problem.
NUL = chr(0) * 4


@pytest.fixture
def client(db: Database, tmp_path):
    auth.set_token(TOKEN)
    app = create_app(settings=config.Settings(data_dir=tmp_path), db=db)
    with TestClient(app) as running:
        yield running


def headers() -> dict[str, str]:
    return {"X-Agent-Studio-Token": TOKEN}


async def _add(db: Database, mission_id: str, title: str) -> None:
    async with db.session() as s:
        s.add(
            Mission(
                id=mission_id,
                kind="mission",
                title=title,
                goal="do the thing",
                status="ended",
                end_reason="completed",
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()


async def _add_corrupt(db: Database) -> None:
    """The row corruption produced, inserted the only way it can be.

    SQLAlchemy refuses a non-datetime for a DateTime column, which is the
    point: no code path in this app can write this row, and only a damaged
    file can hold one. So it goes in as raw SQL.
    """
    async with db.session() as s:
        await s.execute(
            text(
                "insert into missions"
                " (id, kind, title, goal, status, budget, roster_snapshot,"
                "  started_at)"
                " values ('m-bad', 'mission', :nul, 'g', 'ended', '{}', '[]',"
                "  :nul)"
            ),
            {"nul": NUL},
        )
        await s.commit()


@pytest.mark.anyio
async def test_a_row_that_cannot_be_described_is_left_out_and_counted(
    client: TestClient, db: Database
):
    await _add(db, "m-good-1", "Research")
    await _add(db, "m-good-2", "Web app")
    await _add_corrupt(db)

    answer = client.get("/missions", headers=headers())
    assert answer.status_code == 200, "one bad row must not 500 the whole list"

    body = answer.json()
    titles = {m["title"] for m in body["missions"]}
    assert titles == {"Research", "Web app"}, "every good run must still be listed"
    # Counted rather than swallowed: a list quietly missing an entry is the app
    # being untrue about what it holds (§1), and this number is the only clue
    # anybody gets that a database wants looking at.
    assert body["unreadable"] == 1


@pytest.mark.anyio
async def test_a_healthy_database_reports_nothing_unreadable(
    client: TestClient, db: Database
):
    await _add(db, "m-1", "Research")
    body = client.get("/missions", headers=headers()).json()
    assert [m["title"] for m in body["missions"]] == ["Research"]
    assert body["unreadable"] == 0
