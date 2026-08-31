"""Auth on the REST surface, and what CORS is and is not (§9.1).

CORS was added so the browser will let the page read a response — the frontend
runs on another port in dev and another scheme under Tauri. It is emphatically
not the thing keeping callers out; the session token is. These tests pin that
distinction, because a future "just relax CORS for a moment" would otherwise
look like it had loosened security when it had not, and the reverse mistake —
treating an allowed origin as authenticated — would be a real hole.
"""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from agentd.core import auth
from agentd.core.config import ALLOWED_ORIGINS, Settings
from agentd.db.migrate import upgrade_to_head
from agentd.db.session import Database
from agentd.main import create_app

TOKEN = "test-token-abcdef"
DEV_ORIGIN = "http://127.0.0.1:5173"

PROTECTED = [
    ("GET", "/health"),
    ("GET", "/providers"),
    ("GET", "/tools"),
    ("POST", "/missions"),
]


@pytest.fixture
def client(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'auth.db').as_posix()}"
    upgrade_to_head(url)
    database = Database(url)
    auth.set_token(TOKEN)
    with TestClient(create_app(settings=Settings(data_dir=tmp_path), db=database)) as c:
        yield c
    auth._reset_for_tests()


@pytest.mark.parametrize(("method", "path"), PROTECTED)
def test_every_route_refuses_a_request_with_no_token(client, method, path):
    assert client.request(method, path, json={}).status_code == 401


@pytest.mark.parametrize(("method", "path"), PROTECTED)
def test_every_route_refuses_a_wrong_token(client, method, path):
    res = client.request(
        method, path, json={}, headers={"X-Agent-Studio-Token": "wrong"}
    )
    assert res.status_code == 401


def test_health_is_not_an_exception(client):
    """An unauthenticated health endpoint would let any page on this machine
    fingerprint the app and learn which port to attack."""
    assert client.get("/health").status_code == 401
    res = client.get("/health", headers={"X-Agent-Studio-Token": TOKEN})
    assert res.status_code == 200 and res.json()["ok"] is True


def test_an_allowed_origin_is_still_not_authenticated(client):
    """The point of the whole file: being on the allowlist grants nothing."""
    res = client.get("/health", headers={"Origin": DEV_ORIGIN})
    assert res.status_code == 401


def test_the_dev_origin_may_read_responses(client):
    res = client.get(
        "/health", headers={"Origin": DEV_ORIGIN, "X-Agent-Studio-Token": TOKEN}
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == DEV_ORIGIN


def test_an_unlisted_origin_gets_no_cors_grant(client):
    res = client.options(
        "/health",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-agent-studio-token",
        },
    )
    assert "access-control-allow-origin" not in res.headers


def test_the_token_header_is_allowed_through_preflight(client):
    """Without this the browser drops the header and every call reads as
    unauthenticated, which looks like a broken token rather than a CORS gap."""
    res = client.options(
        "/health",
        headers={
            "Origin": DEV_ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-agent-studio-token",
        },
    )
    assert res.status_code in (200, 204)
    allowed = res.headers.get("access-control-allow-headers", "").lower()
    assert "x-agent-studio-token" in allowed


def test_the_allowlist_has_no_wildcard():
    assert "*" not in ALLOWED_ORIGINS
    # Tauri's webview origin differs by platform; all three must be present or
    # the packaged build breaks on one OS only.
    assert "tauri://localhost" in ALLOWED_ORIGINS
    assert "http://tauri.localhost" in ALLOWED_ORIGINS


def test_no_key_is_ever_returned_by_the_provider_api(client):
    """There is no endpoint that returns a key, and this fails if one appears."""
    headers = {"X-Agent-Studio-Token": TOKEN}
    created = client.post(
        "/providers",
        headers=headers,
        json={
            "name": "test",
            "kind": "openai_compatible",
            "model": "m1",
            "base_url": "http://localhost:1",
        },
    ).json()

    assert "key" not in created
    assert created["hasKey"] is False

    listed = client.get("/providers", headers=headers).json()["providers"][0]
    assert set(listed) == {
        "id",
        "name",
        "kind",
        "baseUrl",
        "model",
        "capabilities",
        "verifiedAt",
        "hasKey",
    }
