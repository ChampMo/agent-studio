"""What a finished run actually spent, read off the log.

Not a column. Every `usage` block that reached `mission_events` is the record
of what was paid for, and a second place keeping a running total is a second
place to be wrong (§2.1) — this app has already had one surface disagree with
the guard about the same run, in both directions.

Counted with the guard's own `TOKEN_FIELDS`, so a figure shown beside a ceiling
counts what that ceiling counts. That rule has been needed four times here.

The log is also the reason this can be asked at all for rounds that said
nothing: `agent.usage` exists precisely because a round that only called tools
publishes no message, and its cost would otherwise be invisible.
"""

from __future__ import annotations

from typing import Any, Iterable

from sqlalchemy import select

from ..db.models import MissionEvent
from .budget import tokens_in

#: The event types that can carry a `usage` block.
SPENDING = ("agent.message", "agent.usage")


async def spend_by_mission(
    session: Any, mission_ids: Iterable[str]
) -> dict[str, int]:
    """Tokens spent per mission, for the ids given. Missing ids come back 0.

    One query rather than one per mission: the caller is usually drawing a
    list, and a round trip per row is how a settings panel becomes slow on the
    machine with the most history to show.
    """
    ids = list(mission_ids)
    totals: dict[str, int] = {mission_id: 0 for mission_id in ids}
    if not ids:
        return totals

    rows = (
        await session.execute(
            select(MissionEvent.mission_id, MissionEvent.payload)
            .where(MissionEvent.mission_id.in_(ids))
            .where(MissionEvent.type.in_(SPENDING))
        )
    ).all()
    for mission_id, payload in rows:
        totals[mission_id] = totals.get(mission_id, 0) + tokens_in(
            (payload or {}).get("usage")
        )
    return totals
