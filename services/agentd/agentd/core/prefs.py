"""App-level preferences: read them, write them, and know their defaults.

Two live here. `autonomy` decides when a tool call stops to ask permission, and
the budget decides when a run is stopped for spending too much. It used to be a field on every agent,
which was wrong twice — it asked a security question once per agent when the
person means it once, and it lived in the agent editor, a page nobody has open
while a run is going.

The default is deliberately the cautious one. An unrecognised value is treated
as cautious too, by `needs_approval` itself: a setting this build does not
understand must never be read as "ask less" (§8).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import json

from sqlalchemy import select

from ..core.config import AppBudget
from ..db.models import AppSetting

AUTONOMY_KEY = "autonomy"
BUDGET_KEY = "budget"

#: Ask before anything dangerous — `bash`, `web_fetch`. The middle setting, and
#: the one somebody who has not thought about it should get.
DEFAULT_AUTONOMY = "ask_dangerous"

#: The whole set, in order of how much they ask. `trusted` removes the only
#: gate there is, and there is no sandbox behind it (§2.7).
AUTONOMY_CHOICES = ("ask_always", "ask_dangerous", "trusted")


async def get_autonomy(db: Any) -> str:
    async with db.session() as session:
        row = (
            await session.execute(
                select(AppSetting).where(AppSetting.key == AUTONOMY_KEY)
            )
        ).scalar_one_or_none()
    if row is None or row.value not in AUTONOMY_CHOICES:
        return DEFAULT_AUTONOMY
    return row.value


async def set_autonomy(db: Any, value: str) -> str:
    if value not in AUTONOMY_CHOICES:
        raise ValueError(f"unknown autonomy {value!r}")
    async with db.session() as session:
        row = (
            await session.execute(
                select(AppSetting).where(AppSetting.key == AUTONOMY_KEY)
            )
        ).scalar_one_or_none()
        if row is None:
            row = AppSetting(key=AUTONOMY_KEY, value=value, updated_at=datetime.now(UTC))
            session.add(row)
        else:
            row.value = value
            row.updated_at = datetime.now(UTC)
        await session.commit()
    return value


# ---- the budget -----------------------------------------------------------
#
# `AppBudget`'s numbers were enforced from the first run and editable from
# nowhere. A team asked for four tasks would be stopped at 200,000 tokens with
# no screen saying where that number came from, let alone how to raise it —
# and the run it stopped was usually the one that had just written the files
# and not yet checked them.
#
# They are **ours**, not the provider's. Nothing here is a limit the endpoint
# imposes; it is the ceiling this app stops a run at, and the panel says so.

#: What a person may set each limit to. Wide, because the point is that they
#: know their own account better than this file does — but not unbounded: zero
#: means a run that cannot take a single step, and a limit that large is a
#: typo rather than an intention.
BUDGET_BOUNDS: dict[str, tuple[int, int]] = {
    "max_tokens": (1_000, 100_000_000),
    "max_llm_calls": (1, 10_000),
    "max_supersteps": (1, 10_000),
    "timeout_sec": (30, 86_400),
}

BUDGET_FIELDS = tuple(BUDGET_BOUNDS)


def default_budget() -> AppBudget:
    """The shipped numbers, kept in one place so the panel can offer them back."""
    return AppBudget()


def validate_overrides(values: dict[str, Any] | None) -> dict[str, int]:
    """Check a *partial* budget: a team's default, or one run's.

    Partial is the whole point. `resolve_limits` picks field by field, so a team
    that only wants longer runs sets `timeout_sec` and keeps the app's token
    ceiling — overriding all four to override one is how the two quietly drift
    apart.

    Same bounds as the app budget, because a limit that is safe to set in one
    place is safe in the other, and two tables of numbers would disagree the
    first time either moved.
    """
    if not values:
        return {}
    clean: dict[str, int] = {}
    for field, raw in values.items():
        if field not in BUDGET_BOUNDS:
            raise ValueError(f"{field!r} is not a limit; the limits are: {', '.join(BUDGET_FIELDS)}")
        if raw is None:
            # Explicitly inherited. Dropped rather than stored as null, so the
            # row holds only what was actually decided.
            continue
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ValueError(f"{field} must be a whole number")
        low, high = BUDGET_BOUNDS[field]
        if not low <= raw <= high:
            raise ValueError(f"{field} must be between {low:,} and {high:,}")
        clean[field] = raw
    return clean


async def get_app_budget(db: Any) -> AppBudget:
    """The budget every run starts from.

    Per field, so a stored value that is missing or nonsense falls back to the
    shipped one rather than taking the whole object down with it — the same
    rule `resolve_limits` follows between mission, team and app.
    """
    async with db.session() as session:
        row = (
            await session.execute(select(AppSetting).where(AppSetting.key == BUDGET_KEY))
        ).scalar_one_or_none()

    shipped = default_budget()
    if row is None:
        return shipped
    try:
        stored = json.loads(row.value)
    except (TypeError, ValueError):
        return shipped
    if not isinstance(stored, dict):
        return shipped

    values: dict[str, int] = {}
    for field in BUDGET_FIELDS:
        low, high = BUDGET_BOUNDS[field]
        raw = stored.get(field)
        values[field] = (
            int(raw)
            if isinstance(raw, int) and not isinstance(raw, bool) and low <= raw <= high
            else getattr(shipped, field)
        )
    return AppBudget(**values)


async def set_app_budget(db: Any, values: dict[str, Any]) -> AppBudget:
    """Write the whole budget. Refuses a value outside its bounds by name.

    Whole rather than per field, for the reason the search order is: these four
    are read together on every run, and a half-applied write would leave a run
    measured against two different intentions.
    """
    shipped = default_budget()
    clean: dict[str, int] = {}
    for field in BUDGET_FIELDS:
        raw = values.get(field, getattr(shipped, field))
        low, high = BUDGET_BOUNDS[field]
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ValueError(f"{field} must be a whole number")
        if not low <= raw <= high:
            raise ValueError(f"{field} must be between {low:,} and {high:,}")
        clean[field] = raw

    async with db.session() as session:
        row = (
            await session.execute(select(AppSetting).where(AppSetting.key == BUDGET_KEY))
        ).scalar_one_or_none()
        payload = json.dumps(clean)
        if row is None:
            session.add(
                AppSetting(key=BUDGET_KEY, value=payload, updated_at=datetime.now(UTC))
            )
        else:
            row.value = payload
            row.updated_at = datetime.now(UTC)
        await session.commit()
    return AppBudget(**clean)
