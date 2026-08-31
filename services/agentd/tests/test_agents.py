"""M2 proof: roster CRUD, and the rules the table enforces (§5, §5.2)."""

from __future__ import annotations

import pytest

from agentd.agents.avatar import InvalidAvatar, default_avatar
from agentd.agents.service import AgentNotFound, AgentService, to_json


@pytest.fixture
def service(db):
    return AgentService(db)


def fields(**over):
    return {
        "name": "Mira Vale",
        "title": "Research Analyst",
        "role": "Finds source material",
        "backstory": "An archivist by training.",
        "personality_traits": ["methodical"],
        "system_prompt": "Verify before you assert.",
        "avatar_config": default_avatar(),
        **over,
    }


# ---- what a card is allowed to show ------------------------------------


async def test_the_wire_form_carries_no_invented_score(service):
    """Gamification was rolled back (§1.1, decision row 28): level and exp were
    numbers we made up, and a card showing one is a card that lies."""
    from agentd.db.models import Agent

    agent = await service.create(fields())
    payload = to_json(agent)

    assert not {"level", "exp", "into_level", "level_span"} & set(payload)
    assert "exp" not in {c.name for c in Agent.__table__.columns}


async def test_total_missions_survives_because_it_is_a_fact(service):
    """It counts missions that actually finished, so it says something true."""
    agent = await service.create(fields())
    assert to_json(agent)["totalMissions"] == 0


async def test_total_missions_cannot_be_set_through_the_api(service):
    """A count the user could edit would stop being a record of what happened."""
    agent = await service.create(fields())
    with pytest.raises(ValueError) as exc:
        await service.update(agent.id, {"total_missions": 99})
    assert "total_missions" in str(exc.value)


# ---- CRUD ---------------------------------------------------------------


async def test_create_and_read_back(service):
    created = await service.create(fields())
    fetched = await service.get(created.id)
    assert fetched.name == "Mira Vale"
    assert fetched.total_missions == 0  # earned, never assigned (§5)
    assert fetched.tools == []


async def test_an_edit_persists_and_bumps_updated_at(service):
    agent = await service.create(fields())
    before = agent.updated_at
    updated = await service.update(agent.id, {"name": "Mira V."})
    assert updated.name == "Mira V."
    assert updated.updated_at >= before


async def test_an_invented_avatar_is_rejected_on_the_way_in(service):
    """The generator is not the only path into this table."""
    with pytest.raises(InvalidAvatar):
        await service.create(fields(avatar_config={"body": "gigantic"}))


async def test_an_invented_avatar_is_rejected_on_edit_too(service):
    agent = await service.create(fields())
    with pytest.raises(InvalidAvatar):
        await service.update(agent.id, {"avatar_config": {"hair": "silver_mane"}})


# ---- archive, not delete ------------------------------------------------


async def test_archiving_hides_the_agent_but_keeps_the_row(service):
    """Teams and finished missions still point at it (§5.2)."""
    agent = await service.create(fields())
    await service.archive(agent.id)

    assert [a.id for a in await service.list()] == []
    assert agent.id in [a.id for a in await service.list(include_archived=True)]
    assert (await service.get(agent.id)).archived_at is not None


async def test_archiving_is_reversible(service):
    agent = await service.create(fields())
    await service.archive(agent.id)
    restored = await service.restore(agent.id)
    assert restored.archived_at is None
    assert [a.id for a in await service.list()] == [agent.id]


async def test_a_missing_agent_is_a_lookup_error_not_a_none(service):
    with pytest.raises(AgentNotFound):
        await service.get("agent-nope")


# ---- duplicate: the sanctioned way to freeze a config -------------------


async def test_duplicate_copies_the_configuration_but_not_the_history(service):
    """Teams reference agents live and there is no versioning (§5), so taking a
    copy before editing is how a user keeps the old behaviour. The copy has not
    done the work, so it starts at zero."""
    source = await service.update(
        (await service.create(fields())).id, {"system_prompt": "Be terse."}
    )
    copy = await service.duplicate(source.id)

    assert copy.id != source.id
    assert copy.system_prompt == "Be terse."
    assert copy.avatar_config == source.avatar_config
    assert copy.total_missions == 0  # a copy has not done the work
    assert "copy" in copy.name.lower()


async def test_editing_a_copy_leaves_the_original_alone(service):
    source = await service.create(fields())
    copy = await service.duplicate(source.id)
    await service.update(copy.id, {"system_prompt": "Changed."})
    assert (await service.get(source.id)).system_prompt == "Verify before you assert."
