"""A team's limits, and one run's (§10).

`resolve_limits` has picked mission > team > app **field by field** since M4,
and until now the only layer with a screen was the app. The partial rule is the
whole design: a team that wants longer runs sets `timeout_sec` and keeps
everything else, because overriding all four in order to change one is how two
layers quietly drift apart.

What is tested here is the seam that was missing rather than the resolver — it
already had its own tests. `validate_overrides` is now the one answer to "is
this a legal limit", asked by the team endpoints and the mission endpoint
alike: a run and a team disagreeing about whether 500 tokens is allowed would
be two tables of the same numbers.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agentd.core import auth, config
from agentd.core.budget import resolve_limits
from agentd.core.prefs import default_budget, validate_overrides
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


# ---- what counts as a limit --------------------------------------------


def test_a_partial_budget_stays_partial():
    # Not filled out to four. The absent three are inherited, and writing them
    # down would freeze today's app default into the team.
    assert validate_overrides({"timeout_sec": 1_800}) == {"timeout_sec": 1_800}


def test_none_means_inherit_and_is_not_stored():
    assert validate_overrides({"max_tokens": None, "max_llm_calls": 40}) == {
        "max_llm_calls": 40
    }


def test_nothing_at_all_is_an_empty_dict():
    assert validate_overrides(None) == {}
    assert validate_overrides({}) == {}


def test_a_field_nobody_has_heard_of_is_refused_by_name():
    with pytest.raises(ValueError, match="max_dollars"):
        validate_overrides({"max_dollars": 5})


def test_true_is_not_a_ceiling_of_one():
    # isinstance(True, int) is True in Python, so this needs saying out loud.
    with pytest.raises(ValueError, match="whole number"):
        validate_overrides({"max_tokens": True})


def test_the_bounds_are_the_app_s_bounds():
    # 1 token passes `ge=1` and is not a run. Same table as the app budget.
    with pytest.raises(ValueError, match="max_tokens"):
        validate_overrides({"max_tokens": 1})


# ---- a team's default ---------------------------------------------------


async def test_a_team_keeps_only_what_it_set(client: TestClient):
    made = client.post(
        "/teams",
        headers=headers(),
        json={
            "name": "Long runs",
            "members": [],
            "default_budget": {"timeout_sec": 3_600},
        },
    )
    assert made.status_code == 201
    assert made.json()["defaultBudget"] == {"timeout_sec": 3_600}


async def test_a_team_budget_that_is_not_a_number_is_refused_at_the_door(
    client: TestClient,
):
    # It used to be a free dict: `{"max_tokens": "lots"}` saved cleanly and
    # failed at launch, far from the screen that accepted it.
    refused = client.post(
        "/teams",
        headers=headers(),
        json={"name": "Nope", "members": [], "default_budget": {"max_tokens": "lots"}},
    )
    assert refused.status_code == 400
    assert "max_tokens" in refused.json()["detail"]


async def test_clearing_a_team_budget_is_a_patch_with_an_empty_dict(
    client: TestClient,
):
    team_id = client.post(
        "/teams",
        headers=headers(),
        json={
            "name": "Was long",
            "members": [],
            "default_budget": {"timeout_sec": 3_600},
        },
    ).json()["id"]
    back = client.patch(
        f"/teams/{team_id}", headers=headers(), json={"default_budget": {}}
    )
    assert back.status_code == 200
    assert back.json()["defaultBudget"] == {}


# ---- one run's ----------------------------------------------------------


async def test_a_run_below_the_bounds_is_a_400_not_a_launch(client: TestClient):
    refused = client.post(
        "/missions",
        headers=headers(),
        json={
            "kind": "mission",
            "team_id": "whatever",
            "content": "go",
            "budget": {"max_tokens": 1},
        },
    )
    # Refused for the budget, before the team is even looked up — a 404 here
    # would be the wrong complaint about the wrong thing.
    assert refused.status_code == 400
    assert "max_tokens" in refused.json()["detail"]


# ---- and the chain they feed -------------------------------------------


def test_each_layer_wins_only_where_it_spoke():
    app = default_budget()
    limits = resolve_limits(
        mission={"max_tokens": 500_000},
        team_default={"timeout_sec": 3_600, "max_tokens": 1_000},
        app_default=app,
    )
    # The run's token ceiling beats the team's,
    assert limits.max_tokens == 500_000
    # the team's clock stands because the run said nothing about it,
    assert limits.timeout_sec == 3_600
    # and what neither mentioned is still the app's.
    assert limits.max_llm_calls == app.max_llm_calls
