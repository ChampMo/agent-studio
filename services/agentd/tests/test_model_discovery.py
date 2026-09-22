"""Asking an endpoint what it can run, and running one that wants no key.

Two things the add-a-model form got wrong, both of which only show up on a
machine that is not this one.

**The model id was a bare string.** Its correct spelling exists in exactly one
place — the endpoint — and typing it wrong bought no feedback until a mission
failed on it. So the form asks, and this covers what happens when the answer is
a list, when it is nothing, and when the endpoint refuses.

**A key was mandatory.** Ollama and LM Studio authenticate nothing, so the app
refused to build a client before either had the chance to say so, and a local
model could not be used at all.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agentd.core import auth, config, secrets
from agentd.db.models import ProviderProfile
from agentd.db.session import Database
from agentd.main import create_app
from agentd.providers import registry
from agentd.providers.base import ProviderError

TOKEN = "test-token"


@pytest.fixture
def client(db: Database, tmp_path):
    auth.set_token(TOKEN)
    app = create_app(settings=config.Settings(data_dir=tmp_path), db=db)
    with TestClient(app) as running:
        yield running


def headers() -> dict[str, str]:
    return {"X-Agent-Studio-Token": TOKEN}


class FakeProvider:
    """Only what the route touches."""

    def __init__(self, models=None, error=None):
        self._models = models or []
        self._error = error
        self.closed = False

    async def list_models(self):
        if self._error:
            raise self._error
        return self._models

    async def aclose(self):
        self.closed = True


def test_the_model_list_comes_from_the_endpoint(client: TestClient, monkeypatch):
    built: dict = {}

    def build(kind, *, api_key, base_url=None):
        built.update(kind=kind, api_key=api_key, base_url=base_url)
        return FakeProvider(["b-model", "a-model"])

    monkeypatch.setattr(registry, "build", build)
    answer = client.post(
        "/providers/models",
        headers=headers(),
        json={"kind": "openai_compatible", "base_url": "https://x/v1", "key": "k"},
    )
    assert answer.status_code == 200
    body = answer.json()
    assert body == {"models": ["b-model", "a-model"], "error": None}
    assert built["base_url"] == "https://x/v1"


def test_asking_stores_nothing(client: TestClient, monkeypatch):
    """The key is handed to the SDK for one call and is gone. A profile is
    created afterwards, separately, by the form that used this."""
    monkeypatch.setattr(registry, "build", lambda *a, **k: FakeProvider(["m"]))
    client.post(
        "/providers/models",
        headers=headers(),
        json={"kind": "openai_compatible", "base_url": "https://x/v1", "key": "secret"},
    )
    listed = client.get("/providers", headers=headers()).json()
    assert listed["providers"] == []


def test_a_refusal_comes_back_in_the_endpoints_own_words(
    client: TestClient, monkeypatch
):
    # "Connection refused" and "invalid api key" need completely different
    # fixes, so the message is carried rather than flattened to one sentence.
    monkeypatch.setattr(
        registry,
        "build",
        lambda *a, **k: FakeProvider(error=ProviderError("bad_key", "invalid api key")),
    )
    answer = client.post(
        "/providers/models",
        headers=headers(),
        json={"kind": "openai_compatible", "base_url": "https://x/v1", "key": "wrong"},
    )
    # 200 with an error, not a 500: an endpoint without /models is a normal
    # thing to meet and the form has to stay usable.
    assert answer.status_code == 200
    assert answer.json() == {"models": [], "error": "invalid api key"}


def test_no_key_is_needed_to_ask(client: TestClient, monkeypatch):
    seen: dict = {}

    def build(kind, *, api_key, base_url=None):
        seen["api_key"] = api_key
        return FakeProvider(["llama3"])

    monkeypatch.setattr(registry, "build", build)
    answer = client.post(
        "/providers/models",
        headers=headers(),
        json={
            "kind": "openai_compatible",
            "base_url": "http://localhost:11434/v1",
            "key": None,
        },
    )
    assert answer.json()["models"] == ["llama3"]
    # The SDKs refuse to construct without some string. It says what it is.
    assert seen["api_key"] == registry.NO_KEY_NEEDED


def test_a_profile_with_no_key_still_builds(db: Database, monkeypatch):
    """The change that makes a local server usable at all.

    It used to raise `no_api_key` before the endpoint had any say. Whether a key
    is required is a fact about the endpoint, so the request goes out and the
    endpoint answers — with a 401 if it did want one.
    """
    seen: dict = {}

    def build(kind, *, api_key, base_url=None):
        seen["api_key"] = api_key
        return FakeProvider()

    monkeypatch.setattr(registry, "build", build)
    monkeypatch.setattr(secrets, "get_key", lambda _id: None)

    profile = ProviderProfile(
        id="prov-local",
        name="Ollama",
        kind="openai_compatible",
        base_url="http://localhost:11434/v1",
        model="llama3",
    )
    registry.build_from_profile(profile)
    assert seen["api_key"] == registry.NO_KEY_NEEDED


def test_the_presets_carry_a_base_url_and_never_a_model_id(client: TestClient):
    presets = client.get("/providers", headers=headers()).json()["modelPresets"]
    assert presets, "the form has nothing to start from"
    assert any(p["local"] for p in presets), "no local server is offered"
    for preset in presets:
        assert preset["kind"] in {"openai_compatible", "anthropic"}
        # No model ids ship. Names go stale in silence, and a stale list looks
        # exactly like a fresh one — the mistake pricing.json avoids (§6.2).
        assert "model" not in preset
        assert "models" not in preset


def _save(client: TestClient, kind: str, base_url: str | None, model: str) -> str:
    created = client.post(
        "/providers",
        headers=headers(),
        json={"name": kind, "kind": kind, "model": model, "base_url": base_url},
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


def test_a_saved_endpoint_is_asked_without_a_key_from_the_caller(
    client: TestClient, monkeypatch
):
    """The same question about a profile that already exists.

    The POST above carries the key in its body, which is right for the form
    that has not saved anything yet. It is exactly wrong for an endpoint that
    is already stored: that key is in the OS keychain and the page can never
    read it back (§9.2). So the id is the whole request, and the key is read
    on this side.
    """
    seen: dict = {}

    def build(kind, *, api_key, base_url=None):
        seen.update(kind=kind, api_key=api_key, base_url=base_url)
        return FakeProvider(["deepseek-v4-flash", "deepseek-v4-pro"])

    monkeypatch.setattr(registry, "build", build)
    monkeypatch.setattr(secrets, "get_key", lambda _id: "from-the-keychain")

    profile_id = _save(client, "openai_compatible", "https://api.deepseek.com/v1", "m1")
    answer = client.get(f"/providers/{profile_id}/models", headers=headers())

    assert answer.status_code == 200, answer.text
    assert answer.json() == {
        "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
        "error": None,
    }
    # Read here, from the keychain, exactly as a run does it.
    assert seen["api_key"] == "from-the-keychain"
    assert seen["base_url"] == "https://api.deepseek.com/v1"


def test_a_saved_endpoints_refusal_is_also_carried(client: TestClient, monkeypatch):
    monkeypatch.setattr(
        registry,
        "build",
        lambda *a, **k: FakeProvider(error=ProviderError("no_route", "404 /models")),
    )
    profile_id = _save(client, "openai_compatible", "https://x/v1", "m1")
    answer = client.get(f"/providers/{profile_id}/models", headers=headers())
    # Again a 200 with the endpoint's words, so the form falls back to a text
    # field rather than becoming unusable.
    assert answer.status_code == 200
    assert answer.json() == {"models": [], "error": "404 /models"}


def test_a_search_endpoint_is_refused_rather_than_asked(client: TestClient):
    """Nothing runs on a search key (§16.5), so it has no models to offer.

    An empty list would read as "this endpoint has none", which is a different
    claim from "this is not that kind of endpoint" — and the search adapters
    have no `list_models` to call in the first place.
    """
    profile_id = _save(client, "search", "https://api.search.brave.com", "brave")
    answer = client.get(f"/providers/{profile_id}/models", headers=headers())
    assert answer.status_code == 400
    assert "search" in answer.json()["detail"]


def test_asking_about_an_endpoint_that_is_not_there_is_a_404(client: TestClient):
    answer = client.get("/providers/prov-nope/models", headers=headers())
    assert answer.status_code == 404
