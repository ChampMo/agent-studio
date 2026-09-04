"""A generated name may not be one that is already in use.

The reason this is a *check* and not a line in the prompt is on the record.
The generator produced two different agents called "Mara" — it is never shown
the roster it is adding to, and nothing looked. That is not cosmetic:
`send_message` addresses teammates by name, so one of them would have received
the other's mail and the sender would have been told it worked.

The gate for that landed in `validator.py`, which refuses the *team*. This is
the other half: refusing the name at the point it is invented, so the clash
never reaches a roster the user then has to untangle.
"""

from __future__ import annotations

import json

import pytest

from agentd.agents.profile_gen import (
    ProfileGenerationFailed,
    generate_profile,
)
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage

GOOD_AVATAR = {"build": "average", "coat": "sleek", "outfit": "hoodie", "palette": "grey"}


def profile(name: str) -> str:
    return json.dumps(
        {
            "name": name,
            "title": "Research Lead",
            "role": "Finds and checks sources",
            "backstory": "Two sentences. Then another.",
            "personality_traits": ["methodical", "blunt"],
            "system_prompt": "You research things.",
            "tools": [],
            "avatar_config": GOOD_AVATAR,
        }
    )


class Scripted:
    """Answers with the next canned reply, and remembers what it was asked."""

    def __init__(self, replies: list[str]) -> None:
        self.replies = list(replies)
        self.systems: list[str] = []

    async def stream(self, request, caps):  # noqa: ANN001, ARG002
        self.systems.append(request.system)
        yield TextChunk(self.replies.pop(0))
        yield DoneChunk(usage=Usage(input_tokens=1, output_tokens=1), stop_reason="stop")

    async def aclose(self) -> None:
        return None


CAPS = Capabilities(structured_output="json_object")


async def run(provider, taken: list[str] | None = None, attempts: int = 3):
    return await generate_profile(
        provider=provider,
        caps=CAPS,
        model="m",
        role="a researcher",
        max_attempts=attempts,
        available_tools=[],
        taken=taken,
    )


@pytest.mark.asyncio
async def test_a_taken_name_is_rejected_and_corrected() -> None:
    """The clash is a correction, not a failure: everything else is kept."""
    provider = Scripted([profile("Wren"), profile("Juniper")])

    result = await run(provider, taken=["Wren"])

    assert result.profile.name == "Juniper"
    assert result.attempts == 2
    # Surfaced rather than hidden — a profile that took two tries is a fact
    # about the run, and the user is shown it.
    assert "already belongs to another agent" in result.recovered_from[0]
    assert "'Wren'" in result.recovered_from[0]


@pytest.mark.asyncio
async def test_the_comparison_ignores_case_and_padding() -> None:
    """The same normalisation `validator.py` uses for `duplicate_name`.

    If these two disagreed, the generator would hand back a name the run gate
    then refuses — one idea with two answers (§2.1).
    """
    provider = Scripted([profile("  wren "), profile("Moss")])

    result = await run(provider, taken=["Wren"])

    assert result.profile.name == "Moss"


@pytest.mark.asyncio
async def test_the_taken_names_are_told_to_the_model_too() -> None:
    """Checked *and* asked for. The check is what makes it true; telling the
    model is what stops it costing a retry every time."""
    provider = Scripted([profile("Moss")])

    await run(provider, taken=["Wren", "Bo"])

    system = provider.systems[0]
    assert "already in use" in system
    # Sorted, so an unchanged roster sends a byte-identical prompt and the
    # provider's cache still hits.
    assert system.index("  Bo") < system.index("  Wren")


@pytest.mark.asyncio
async def test_no_taken_names_adds_nothing_to_the_prompt() -> None:
    """An empty heading is prompt re-sent on every correction round to say
    nothing at all."""
    provider = Scripted([profile("Moss")])

    await run(provider, taken=[])

    assert "already in use" not in provider.systems[0]


@pytest.mark.asyncio
async def test_a_model_that_will_not_move_off_the_name_fails() -> None:
    """Three attempts, all clashing. It raises rather than returning a
    duplicate — the whole point is that this cannot be produced."""
    provider = Scripted([profile("Wren")] * 3)

    with pytest.raises(ProfileGenerationFailed) as caught:
        await run(provider, taken=["Wren"])

    assert len(caught.value.attempts) == 3


@pytest.mark.asyncio
async def test_the_prompt_asks_for_a_name_that_suits_a_cat() -> None:
    """Every character is drawn as a cat, so the name sits on one whether or
    not anyone thought about it. What is asked for is a name that works for a
    cat *and* a colleague — the title and the role stay serious."""
    provider = Scripted([profile("Moss")])

    await run(provider)

    system = provider.systems[0]
    assert "cat" in system
    # And explicitly not the joke version: a team of Whiskers and Miss Paws
    # cannot be read as a record of who did what.
    assert "Whiskers" in system
