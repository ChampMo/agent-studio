"""The ceilings a run is stopped at, and who gets to set them (§10).

`AppBudget`'s four numbers enforced every run from the first release and were
editable from nowhere. A team could be killed at 200,000 tokens with no screen
saying what that number was or where it came from — and it was usually the run
that had just written the files and not yet checked them.

Stored per field, read per field. A value that is missing, out of range or the
wrong type falls back to the shipped one rather than taking the whole budget
down with it, which is the rule `resolve_limits` already follows between the
mission, the team and the app.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from agentd.core import auth, config
from agentd.core.budget import resolve_limits
from agentd.core.prefs import (
    BUDGET_KEY,
    default_budget,
    get_app_budget,
    set_app_budget,
)
from agentd.db.models import AppSetting
from agentd.db.session import Database
from agentd.main import create_app

TOKEN = "test-token"

pytestmark = pytest.mark.anyio


@pytest.fixture
def client(db: Database, tmp_path):
    auth.set_token(TOKEN)
    app = create_app(settings=config.Settings(data_dir=tmp_path), db=db)
    with TestClient(app) as running:
        yield running


def headers() -> dict[str, str]:
    return {"X-Agent-Studio-Token": TOKEN}


async def store(db: Database, raw: str) -> None:
    from datetime import UTC, datetime

    async with db.session() as s:
        row = (
            await s.execute(select(AppSetting).where(AppSetting.key == BUDGET_KEY))
        ).scalar_one_or_none()
        if row is None:
            s.add(AppSetting(key=BUDGET_KEY, value=raw, updated_at=datetime.now(UTC)))
        else:
            row.value = raw
        await s.commit()


# ---- reading and writing ------------------------------------------------


async def test_an_untouched_install_gets_the_shipped_numbers(db: Database):
    assert await get_app_budget(db) == default_budget()


async def test_what_is_saved_comes_back(db: Database):
    await set_app_budget(
        db,
        {
            "max_tokens": 400_000,
            "max_llm_calls": 80,
            "max_supersteps": 90,
            "timeout_sec": 1_800,
        },
    )
    saved = await get_app_budget(db)
    assert saved.max_tokens == 400_000
    assert saved.timeout_sec == 1_800


async def test_a_value_out_of_range_is_refused_by_name(db: Database):
    with pytest.raises(ValueError) as raised:
        await set_app_budget(db, {**default_budget().__dict__, "max_tokens": 5})
    # Named, with the range, so the field that is wrong is obvious.
    assert "max_tokens" in str(raised.value)


async def test_a_ceiling_of_zero_is_refused(db: Database):
    # A run that cannot take a single step is not a budget, it is a typo.
    for field in ("max_tokens", "max_llm_calls", "max_supersteps", "timeout_sec"):
        with pytest.raises(ValueError):
            await set_app_budget(db, {**default_budget().__dict__, field: 0})


async def test_nonsense_on_disk_falls_back_field_by_field(db: Database):
    # Not all-or-nothing: one bad field must not lose the other three.
    await store(
        db,
        json.dumps({"max_tokens": 300_000, "timeout_sec": "soon", "max_llm_calls": None}),
    )
    saved = await get_app_budget(db)
    shipped = default_budget()
    assert saved.max_tokens == 300_000
    assert saved.timeout_sec == shipped.timeout_sec
    assert saved.max_llm_calls == shipped.max_llm_calls


async def test_a_corrupt_row_does_not_break_launching(db: Database):
    await store(db, "{not json")
    assert await get_app_budget(db) == default_budget()


async def test_true_is_not_a_number(db: Database):
    # `isinstance(True, int)` is True in Python, and a budget of `True` would
    # be a ceiling of one.
    with pytest.raises(ValueError):
        await set_app_budget(db, {**default_budget().__dict__, "max_tokens": True})


# ---- and it actually reaches a run --------------------------------------


async def test_the_saved_budget_is_what_a_run_starts_from(db: Database):
    await set_app_budget(db, {**default_budget().__dict__, "max_tokens": 400_000})
    limits = resolve_limits(app_default=await get_app_budget(db))
    assert limits.max_tokens == 400_000


async def test_a_mission_override_still_wins(db: Database):
    # Precedence is unchanged: mission > team > app. Raising the app default
    # must not overrule a run that asked for something specific.
    await set_app_budget(db, {**default_budget().__dict__, "max_tokens": 400_000})
    limits = resolve_limits(
        mission={"max_tokens": 50_000}, app_default=await get_app_budget(db)
    )
    assert limits.max_tokens == 50_000
    # And the fields it did not name still come from the new app default.
    assert limits.timeout_sec == default_budget().timeout_sec


# ---- over the wire ------------------------------------------------------


def test_the_panel_is_told_the_shipped_values_too(client: TestClient):
    # So "reset" can be offered without the UI keeping its own copy to drift.
    body = client.get("/prefs/budget", headers=headers()).json()
    assert body["value"] == body["shipped"]
    assert set(body["bounds"]) == set(body["value"])


def test_saving_over_the_wire_sticks(client: TestClient):
    put = client.put(
        "/prefs/budget",
        headers=headers(),
        json={
            "max_tokens": 400_000,
            "max_llm_calls": 40,
            "max_supersteps": 60,
            "timeout_sec": 1_800,
        },
    )
    assert put.status_code == 200
    assert put.json()["value"]["max_tokens"] == 400_000
    assert client.get("/prefs/budget", headers=headers()).json()["value"][
        "timeout_sec"
    ] == 1_800


def test_a_bad_value_is_a_400_that_says_which_field(client: TestClient):
    refused = client.put(
        "/prefs/budget",
        headers=headers(),
        json={
            "max_tokens": 1,
            "max_llm_calls": 40,
            "max_supersteps": 60,
            "timeout_sec": 900,
        },
    )
    assert refused.status_code == 400
    assert "max_tokens" in refused.json()["detail"]


# ---- storage ------------------------------------------------------------


def test_storage_names_the_folder_and_measures_it(client: TestClient):
    body = client.get("/storage", headers=headers()).json()
    assert body["root"]
    ids = {part["id"] for part in body["parts"]}
    assert ids == {"database", "artifacts", "attachments"}
    for part in body["parts"]:
        # A folder that is not there yet reports zero rather than being left
        # out: "no artifacts yet" and "no such thing" read very differently.
        assert part["bytes"] >= 0
        assert "exists" in part
        assert part["path"]
