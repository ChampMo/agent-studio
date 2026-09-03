"""A mission timestamp on the wire carries its offset (§1, §9.2).

`DateTime(timezone=True)` is a no-op on SQLite: it writes a naive string and
reads one back. A naive ISO string is read by a browser as *local* time, so on a
UTC+7 machine the rail reported a run that had started five seconds ago as
**"Time used 7:00:05 / 15:00"** — the app stating, as a number, something that
was not true.

`_wire` fixed exactly this for event timestamps in M1. It went unnoticed here
for as long as it did because a *finished* run is measured from `startedAt` to
`endedAt`, and both were shifted equally, so the difference came out right. Only
a live run — measured against `Date.now()` — showed the offset.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agentd.core.events import as_utc_iso


def test_a_naive_datetime_is_labelled_utc():
    # What SQLite hands back.
    naive = datetime(2026, 9, 1, 19, 45, 6, 931139)
    assert as_utc_iso(naive) == "2026-09-01T19:45:06.931139+00:00"


def test_an_aware_datetime_keeps_its_offset():
    aware = datetime(2026, 9, 1, 19, 45, 6, tzinfo=UTC)
    assert as_utc_iso(aware) == "2026-09-01T19:45:06+00:00"


def test_none_stays_none():
    # A mission that has not ended has no `endedAt`, and inventing one would be
    # worse than the bug this file is about.
    assert as_utc_iso(None) is None


@pytest.mark.parametrize("field", ["startedAt", "endedAt"])
def test_both_mission_timestamps_go_out_with_an_offset(field: str):
    """The serialisers, not just the helper.

    Asserted on the output rather than by reading the call site, because the
    bug was one `.isoformat()` that nobody looked at twice.
    """
    from agentd.api import chat, hitl

    for module in (chat, hitl):
        source = (module.__file__ or "")
        assert source
        text = open(source, encoding="utf-8").read()
        assert f'"{field}": as_utc_iso(' in text, f"{module.__name__} still bare"
        assert f'"{field}": m.' not in text.replace("as_utc_iso(m.", "")
