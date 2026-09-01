"""Creating provider profiles through the API (§16.5, §16.8).

Written because of what it would have caught. M8 added a `search` kind to the
request model, the serialiser, the tool registry and the UI, and not to the
CHECK constraint in the database — so saving a search endpoint failed with an
IntegrityError every time, and had never once worked. Nothing inserted one: the
search adapters are tested against recorded responses and everything else only
reads.

The lesson is narrower than "test the API": a value that appears in a Python
`Literal` and in a database constraint exists in two places, and only one of
them was updated.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agentd.core import auth, config
from agentd.db.session import Database
from agentd.main import create_app

TOKEN = "test-token"


@pytest.fixture
def client(db: Database, tmp_path):
    auth.set_token(TOKEN)
    app = create_app(settings=config.Settings(data_dir=tmp_path), db=db)
    with TestClient(app) as running:
        yield running


def headers() -> dict[str, str]:
    return {"X-Agent-Studio-Token": TOKEN}


def test_a_search_endpoint_can_actually_be_saved(client: TestClient):
    created = client.post(
        "/providers",
        headers=headers(),
        json={
            "name": "Brave Search",
            "kind": "search",
            "model": "brave",
            "base_url": "https://api.search.brave.com",
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["kind"] == "search"
    assert body["hasKey"] is False

    listed = client.get("/providers", headers=headers()).json()
    assert [p["kind"] for p in listed["providers"]] == ["search"]
    # And the UI is told which engines it may offer.
    assert {e["id"] for e in listed["searchEngines"]} == {"tavily", "brave"}


def test_a_model_endpoint_still_saves(client: TestClient):
    for kind, base in [
        ("openai_compatible", "https://api.deepseek.com/v1"),
        ("anthropic", None),
    ]:
        created = client.post(
            "/providers",
            headers=headers(),
            json={"name": kind, "kind": kind, "model": "m1", "base_url": base},
        )
        assert created.status_code == 201, created.text


def test_an_invented_kind_is_refused_before_it_reaches_the_table(client: TestClient):
    # 422 from the request model, not a 500 from the constraint: the two agree
    # on the same three values, which is the thing that broke.
    refused = client.post(
        "/providers",
        headers=headers(),
        json={"name": "x", "kind": "telepathy", "model": "m1"},
    )
    assert refused.status_code == 422


def test_native_search_is_refused_on_an_endpoint_that_cannot_do_it(client: TestClient):
    created = client.post(
        "/providers",
        headers=headers(),
        json={
            "name": "DeepSeek",
            "kind": "openai_compatible",
            "model": "deepseek-v4-flash",
            "base_url": "https://api.deepseek.com/v1",
        },
    ).json()
    assert created["nativeSearchAvailable"] is False

    # `/v1` is the OpenAI-compatible API and does not run the search itself. A
    # switch that stored and did nothing would be worse than no switch (§16.8).
    refused = client.patch(
        f"/providers/{created['id']}", headers=headers(), json={"native_search": True}
    )
    assert refused.status_code == 400
    assert "api.deepseek.com/anthropic" in refused.text


def test_native_search_is_allowed_on_the_endpoint_that_supports_it(client: TestClient):
    created = client.post(
        "/providers",
        headers=headers(),
        json={
            "name": "DeepSeek (Anthropic)",
            "kind": "anthropic",
            "model": "deepseek-v4-flash",
            "base_url": "https://api.deepseek.com/anthropic",
        },
    ).json()
    assert created["nativeSearchAvailable"] is True
    assert created["nativeSearch"] is False  # off until asked for

    turned_on = client.patch(
        f"/providers/{created['id']}", headers=headers(), json={"native_search": True}
    )
    assert turned_on.status_code == 200
    assert turned_on.json()["nativeSearch"] is True


def test_moving_a_profile_off_that_endpoint_turns_the_flag_off(client: TestClient):
    created = client.post(
        "/providers",
        headers=headers(),
        json={
            "name": "DeepSeek (Anthropic)",
            "kind": "anthropic",
            "model": "m",
            "base_url": "https://api.deepseek.com/anthropic",
        },
    ).json()
    client.patch(f"/providers/{created['id']}", headers=headers(), json={"native_search": True})

    moved = client.patch(
        f"/providers/{created['id']}",
        headers=headers(),
        json={"base_url": "https://api.anthropic.com"},
    ).json()
    # Otherwise the flag stays on, pointing at something that ignores it.
    assert moved["nativeSearch"] is False


def test_renaming_a_profile_does_not_erase_its_base_url(client: TestClient):
    """The bug underneath: a field the caller never sent was read as "set this
    to null", so a rename silently broke the endpoint it pointed at."""
    created = client.post(
        "/providers",
        headers=headers(),
        json={
            "name": "DeepSeek",
            "kind": "openai_compatible",
            "model": "deepseek-v4-flash",
            "base_url": "https://api.deepseek.com/v1",
        },
    ).json()

    renamed = client.patch(
        f"/providers/{created['id']}", headers=headers(), json={"name": "DeepSeek (main)"}
    ).json()

    assert renamed["name"] == "DeepSeek (main)"
    assert renamed["baseUrl"] == "https://api.deepseek.com/v1"
    # And the capabilities are not cleared either: nothing about the endpoint
    # changed, so the readings still describe it.
    assert renamed["verifiedAt"] == created["verifiedAt"]


def test_a_base_url_can_still_be_cleared_on_purpose(client: TestClient):
    # Null is a real value here — an Anthropic profile has no base URL — so
    # "absent" and "explicitly null" have to stay distinguishable.
    created = client.post(
        "/providers",
        headers=headers(),
        json={"name": "x", "kind": "anthropic", "model": "m", "base_url": "https://x.test"},
    ).json()

    cleared = client.patch(
        f"/providers/{created['id']}", headers=headers(), json={"base_url": None}
    ).json()
    assert cleared["baseUrl"] is None


def test_a_crash_still_answers_with_cors_headers(client: TestClient, monkeypatch):
    """Why the last two bugs were so hard to see.

    An unhandled exception never reaches the CORS middleware, so the reply
    arrives with no `Access-Control-Allow-Origin` header and the browser blames
    CORS — the one thing that was not wrong. A 500 that a page can read says
    "the backend broke", which is where to look.
    """
    from agentd.api import settings as settings_api

    def explode(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(settings_api.registry, "available_kinds", explode)

    # `raise_server_exceptions=False` so the client behaves like a browser:
    # it wants the response the server would really send.
    with TestClient(client.app, raise_server_exceptions=False) as browserlike:
        crashed = browserlike.get(
            "/providers", headers={**headers(), "Origin": "http://localhost:5173"}
        )
    assert crashed.status_code == 500
    assert crashed.headers.get("access-control-allow-origin") == "http://localhost:5173"
    # The traceback stays in the log rather than in the body.
    assert "boom" not in crashed.text
