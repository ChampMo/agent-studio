"""Which search key is tried first, and who decides (§16.5).

The chain used to be ordered by `created_at` — "the order to try them" and "the
order you happened to add them" quietly being the same thing. They stop being
the same the moment someone wants the cheaper key spent first, so the order is
set explicitly now.

The tests that matter are the refusals. A position is a claim about the other
rows, so a half-applied order leaves the runner reading a table where two keys
claim one place — and the runner is reading it while a mission is running.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from agentd.core import auth, config
from agentd.db.models import ProviderProfile
from agentd.db.session import Database
from agentd.main import create_app
from agentd.providers import registry

TOKEN = "test-token"


@pytest.fixture
def client(db: Database, tmp_path):
    auth.set_token(TOKEN)
    app = create_app(settings=config.Settings(data_dir=tmp_path), db=db)
    with TestClient(app) as running:
        yield running


def headers() -> dict[str, str]:
    return {"X-Agent-Studio-Token": TOKEN}


def make(client: TestClient, name: str, kind: str = "search") -> str:
    created = client.post(
        "/providers",
        headers=headers(),
        json={
            "name": name,
            "kind": kind,
            "model": name.lower(),
            "base_url": f"https://api.{name.lower()}.example",
        },
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


def shown(client: TestClient) -> list[str]:
    listed = client.get("/providers", headers=headers()).json()["providers"]
    return [p["name"] for p in listed if p["kind"] == "search"]


def test_the_order_defaults_to_the_order_they_were_added(client: TestClient):
    make(client, "First")
    make(client, "Second")
    # Nobody has expressed a preference, so nothing is invented: the chain runs
    # oldest first, exactly as it did before the column existed.
    assert shown(client) == ["First", "Second"]


def test_a_key_can_be_moved_to_the_front(client: TestClient):
    first = make(client, "First")
    second = make(client, "Second")

    moved = client.post(
        "/providers/search-order", headers=headers(), json={"ids": [second, first]}
    )
    assert moved.status_code == 200
    assert shown(client) == ["Second", "First"]


def test_a_partial_order_is_refused(client: TestClient):
    first = make(client, "First")
    make(client, "Second")

    # Naming one of two says nothing about where the other goes, and putting it
    # somewhere would be the app deciding something nobody asked it to.
    refused = client.post(
        "/providers/search-order", headers=headers(), json={"ids": [first]}
    )
    assert refused.status_code == 400
    assert "every search endpoint" in refused.json()["detail"]
    assert shown(client) == ["First", "Second"]


def test_a_repeated_id_is_refused(client: TestClient):
    first = make(client, "First")
    make(client, "Second")

    refused = client.post(
        "/providers/search-order", headers=headers(), json={"ids": [first, first]}
    )
    assert refused.status_code == 400
    assert "twice" in refused.json()["detail"]
    assert shown(client) == ["First", "Second"]


def test_a_model_endpoint_cannot_be_put_in_the_search_chain(client: TestClient):
    search = make(client, "First")
    model = make(client, "Amodel", kind="openai_compatible")

    refused = client.post(
        "/providers/search-order", headers=headers(), json={"ids": [search, model]}
    )
    assert refused.status_code == 400
    assert "not a search endpoint" in refused.json()["detail"]


def test_a_key_added_later_falls_in_behind_an_ordered_chain(client: TestClient):
    first = make(client, "First")
    second = make(client, "Second")
    client.post(
        "/providers/search-order", headers=headers(), json={"ids": [second, first]}
    )

    # A new key has no position, and null sorts last. Slotting it in ahead of
    # keys someone deliberately ordered would overrule that decision.
    make(client, "Third")
    assert shown(client) == ["Second", "First", "Third"]


def test_the_list_and_the_runner_agree_on_the_order(db: Database, client: TestClient):
    """One ordering expression, used by the panel and by the code that spends
    the keys. Two would drift, and the one on screen would be the wrong one."""
    import asyncio

    first = make(client, "First")
    second = make(client, "Second")
    client.post(
        "/providers/search-order", headers=headers(), json={"ids": [second, first]}
    )

    async def read() -> list[str]:
        async with db.session() as s:
            rows = (
                await s.execute(
                    select(ProviderProfile)
                    .where(ProviderProfile.kind == "search")
                    .order_by(*registry.search_order())
                )
            ).scalars().all()
        return [row.name for row in rows]

    assert shown(client) == asyncio.run(read())
