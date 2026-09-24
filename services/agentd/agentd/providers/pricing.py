"""Turn token counts into dollars, or into nothing at all.

`costUsd` is optional in the event schema for exactly one reason: a made-up
price written into an append-only table is worse than a blank, because later it
reads as fact. An unknown model produces `None` and the UI shows tokens only.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .base import Usage

_PRICING_FILE = Path(__file__).with_name("pricing.json")


#: What a build with no rate table behaves like: every model unpriced, which is
#: already a state this app renders honestly as "Not priced".
_NOTHING: dict[str, Any] = {
    "pricing_as_of": "",
    "models": {},
    "cache_read_multiplier": 1.0,
    "cache_write_multiplier": 1.0,
}


@lru_cache(maxsize=1)
def _table() -> dict[str, Any]:
    """The shipped rates, or an empty table when the file is not there.

    **It was not there**, in every packaged build. PyInstaller cannot see a
    file that nothing imports, and this one is opened by path — so a frozen
    backend raised `FileNotFoundError` from `_MEIPASS/agentd/providers/
    pricing.json` on the first usage record, which is the first model reply,
    which killed the mission with `internal_error` before a single task ran.
    The spec bundles it now.

    Falling back rather than raising is the other half, and it is the half that
    matters next time. Not knowing a price is an ordinary state here: DeepSeek
    has never been in this table, `cost_usd` returns None for it, and the UI
    says "Not priced". A missing *file* is the same ignorance at a larger
    scale, and it has no business ending a run that was working. Our own
    missing data must never be written down as a fact about the world (§1.1) —
    and it must not take the work down with it either.
    """
    try:
        return json.loads(_PRICING_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _NOTHING


def pricing_as_of() -> str:
    return _table()["pricing_as_of"]


def known_models() -> list[str]:
    return sorted(_table()["models"])


def cost_usd(model: str, usage: Usage) -> float | None:
    """Cost for one call, or None when the model has no published rate here."""
    rates = _table()["models"].get(model)
    if not rates:
        return None

    per_million = lambda tokens, rate: (tokens / 1_000_000) * rate  # noqa: E731
    table = _table()

    total = per_million(usage.input_tokens, rates["input"])
    total += per_million(usage.output_tokens, rates["output"])
    # Cache traffic is priced off the input rate: reads far below it, writes
    # somewhat above. Falling back to 1.0 would overcharge reads tenfold.
    total += per_million(
        usage.cache_read_tokens,
        float(
            rates.get("cache_read")
            or rates["input"] * table["cache_read_multiplier"]
        ),
    )
    total += per_million(
        usage.cache_write_tokens,
        float(
            rates.get("cache_write")
            or rates["input"] * table["cache_write_multiplier"]
        ),
    )
    return round(total, 8)
