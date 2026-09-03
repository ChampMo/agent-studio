"""Two teammates with one name (§5.2, §16.6).

Found by using the app. The profile generator was asked for an artist and then
for an art director; it named both **Mara**, because it is never shown the
roster it is adding to. The app accepted the second without a word, and the two
sat side by side on the roster page.

That is not a cosmetic problem. `send_message` addresses a teammate *by name*,
and the old `Mailbox.resolve` returned the first match — so a message meant for
one Mara was delivered to the other, and the sender was told it had worked. The
timeline and the scene label everyone by name too, so the record could not say
which of them acted.

Both halves are here: the validator refuses such a team, and the mailbox refuses
to guess if one ever reaches it anyway.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agentd.db.models import Agent, TeamMember
from agentd.teams.validator import blocking, validate
from agentd.tools.base import ToolContext, ToolFailed
from agentd.tools.team import Ambiguous, Mailbox, send_message


def agent(agent_id: str, name: str) -> Agent:
    return Agent(
        id=agent_id,
        name=name,
        provider_id="p1",
        model="m1",
        tools=[],
        avatar_config={},
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )


def team_of(*pairs: tuple[str, str]):
    members = [
        TeamMember(
            team_id="t1",
            agent_id=agent_id,
            seat_index=i,
            role_in_team="leader" if i == 0 else "member",
        )
        for i, (agent_id, _) in enumerate(pairs)
    ]
    agents = {agent_id: agent(agent_id, name) for agent_id, name in pairs}
    return members, agents


def test_a_team_with_two_agents_of_the_same_name_cannot_run():
    members, agents = team_of(("a1", "Mara"), ("a2", "Mara"))
    findings = validate(layout_id="war_room", members=members, agents=agents)

    clash = [f for f in findings if f.code == "duplicate_name"]
    assert clash, "the duplicate went unreported"
    assert clash[0].severity == "error"
    assert "Mara" in clash[0].message
    assert any(f.code == "duplicate_name" for f in blocking(findings))


def test_the_comparison_ignores_case_and_padding():
    # "mara" and "Mara " are the same name to anyone reading, and to the
    # resolver, so they have to be the same name here.
    members, agents = team_of(("a1", "Mara"), ("a2", " mara "))
    findings = validate(layout_id="war_room", members=members, agents=agents)
    assert any(f.code == "duplicate_name" for f in findings)


def test_distinct_names_raise_nothing():
    members, agents = team_of(("a1", "Mara"), ("a2", "Ilse"))
    findings = validate(layout_id="war_room", members=members, agents=agents)
    assert not [f for f in findings if f.code == "duplicate_name"]


def test_the_mailbox_refuses_to_guess():
    box = Mailbox({"a1": "Mara", "a2": "Mara"})
    with pytest.raises(Ambiguous) as caught:
        box.resolve("Mara")
    assert caught.value.names == ["Mara", "Mara"]


def test_an_id_still_resolves_even_when_the_names_clash():
    # The id is unambiguous by construction, and a model that used one should
    # not be punished for the roster's problem.
    box = Mailbox({"a1": "Mara", "a2": "Mara"})
    assert box.resolve("a1") == "a1"


async def test_send_message_reports_the_clash_instead_of_delivering():
    box = Mailbox({"a1": "Mara", "a2": "Mara"})
    ctx = ToolContext(
        mission_id="m1", agent_id="a3", workspace_root=None, extras={"mailbox": box}
    )

    with pytest.raises(ToolFailed) as caught:
        await send_message(ctx, to="Mara", content="the brief is ready")

    assert caught.value.code == "ambiguous_recipient"
    # And nothing was delivered to either of them.
    assert box.collect("a1") == []
    assert box.collect("a2") == []
