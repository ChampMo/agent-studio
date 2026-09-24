"""A build with no rate table prices nothing, and runs anyway.

`pricing.json` is opened by path, so PyInstaller could not see it and no
packaged build ever shipped it. The frozen backend raised `FileNotFoundError`
on the first usage record — which is the first model reply — and the mission
died with `internal_error` before a task ran. Every packaged release from
v0.1.0 to v0.2.3 could not complete a single mission.

The spec bundles the file now. This covers the other half: not knowing a price
is an ordinary state in this app, and it must never be the thing that ends a
run.
"""

from __future__ import annotations

import pytest

from agentd.providers import pricing
from agentd.providers.base import Usage


@pytest.fixture(autouse=True)
def _fresh_table():
    pricing._table.cache_clear()
    yield
    pricing._table.cache_clear()


def _gone(monkeypatch, tmp_path):
    monkeypatch.setattr(pricing, "_PRICING_FILE", tmp_path / "not-here.json")


def test_a_missing_table_prices_nothing_instead_of_raising(monkeypatch, tmp_path):
    _gone(monkeypatch, tmp_path)
    usage = Usage(input_tokens=1000, output_tokens=1000)
    # None is what an unknown model already returns, and the UI renders it as
    # "Not priced". A missing file is the same ignorance, larger.
    assert pricing.cost_usd("gpt-4o", usage) is None
    assert pricing.known_models() == []
    assert pricing.pricing_as_of() == ""


def test_a_corrupt_table_is_the_same_as_a_missing_one(monkeypatch, tmp_path):
    bad = tmp_path / "pricing.json"
    bad.write_text("{not json at all", encoding="utf-8")
    monkeypatch.setattr(pricing, "_PRICING_FILE", bad)
    assert pricing.cost_usd("gpt-4o", Usage(input_tokens=1, output_tokens=1)) is None


def test_the_real_table_is_still_read(monkeypatch, tmp_path):
    # The fallback must not be hiding a table that is actually there.
    assert pricing.pricing_as_of() != ""
    assert len(pricing.known_models()) > 0
