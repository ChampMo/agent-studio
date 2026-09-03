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


@lru_cache(maxsize=1)
def _table() -> dict[str, Any]:
    return json.loads(_PRICING_FILE.read_text(encoding="utf-8"))


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
