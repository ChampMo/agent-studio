"""Turning the questions off stops them on the next tool call.

This is a deliberate exception to the frozen snapshot, and the reason is worth
keeping: the snapshot protects the *record* — who was on the run, what they
carried, what they were asked. A permission is not a record. It is a live
instruction from the person sitting in front of it, and someone who says "stop
asking" because the question on screen is in their way is not served by being
told it will apply to some future run.

What the log records does not change. Every question that was asked is still on
it; the ones that were never asked never happened.
"""

from __future__ import annotations

import pytest

from agentd.tools.execution import ToolBox, needs_approval
from agentd.tools.registry import BY_ID


DANGEROUS = BY_ID["bash"]
SAFE = BY_ID["read_file"]


def box(frozen: str, live=None) -> ToolBox:
    return ToolBox(
        specs=[DANGEROUS, SAFE],
        context=None,  # type: ignore[arg-type]
        autonomy=frozen,
        live_autonomy=live,
    )


@pytest.mark.asyncio
async def test_the_switch_beats_what_the_run_started_under():
    # Launched asking about dangerous tools; the person has since said no.
    tools = box("ask_dangerous", live=lambda: _value("trusted"))
    assert await tools.needs_approval(DANGEROUS) is False


@pytest.mark.asyncio
async def test_it_can_tighten_mid_run_as_well_as_loosen():
    # The same door in the other direction: a run launched under "never ask"
    # starts asking again the moment somebody wants it to.
    tools = box("trusted", live=lambda: _value("ask_always"))
    assert await tools.needs_approval(SAFE) is True


@pytest.mark.asyncio
async def test_a_setting_that_cannot_be_read_keeps_the_run_as_cautious():
    # A database that will not answer is not permission to skip the gate. It
    # falls back to what the run started under, which is at least as careful.
    async def broken() -> str:
        raise RuntimeError("no database")

    tools = box("ask_dangerous", live=broken)
    assert await tools.needs_approval(DANGEROUS) is True


@pytest.mark.asyncio
async def test_with_nothing_live_it_uses_the_frozen_value():
    # Every caller that has no database — a test, a tool run outside a mission
    # — behaves exactly as it did before.
    assert await box("ask_dangerous").needs_approval(DANGEROUS) is True
    assert await box("trusted").needs_approval(DANGEROUS) is False


def test_the_table_itself_is_unchanged():
    # The live read decides *which* autonomy value is used, never what a value
    # means. An unrecognised one is still read as "ask" (§8).
    assert needs_approval(risk="dangerous", autonomy="ask_dangerous") is True
    assert needs_approval(risk="safe", autonomy="ask_dangerous") is False
    assert needs_approval(risk="safe", autonomy="who-knows") is True


async def _value(v: str) -> str:
    return v
