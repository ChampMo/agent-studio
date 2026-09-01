"""send_message, ask_user, remember and recall (§16.7).

`send_message` is the tool that makes the split-team advice in §16.6 worth
following: telling people to separate the agent that reads the web from the one
that writes files only helps if the two can hand work over. So the test that
matters is delivery, not logging.

`recall` is keyword search and says so. The test pins that it says so when it
finds nothing — a model told "no memories match" would conclude it never knew
the thing, and go and find it out again.
"""

from __future__ import annotations

import pytest

from agentd.tools import memory, team
from agentd.tools.base import ToolContext, ToolFailed


def ctx_with(**extras) -> ToolContext:
    return ToolContext(mission_id="m-1", agent_id="a-1", extras=extras)


# ---- send_message ------------------------------------------------------


async def test_a_message_is_delivered_to_the_named_teammate():
    mailbox = team.Mailbox({"a-1": "Scout", "a-2": "Clara"})
    result = await team.send_message(
        ctx_with(mailbox=mailbox), to="Clara", content="Three sources, all 2023."
    )
    assert "Clara" in result.summary
    # Waiting for her, not for anyone else.
    assert mailbox.collect("a-2") == [("a-1", "Three sources, all 2023.")]
    assert mailbox.collect("a-1") == []


async def test_a_message_can_be_addressed_by_id_or_by_name():
    mailbox = team.Mailbox({"a-1": "Scout", "a-2": "Clara"})
    await team.send_message(ctx_with(mailbox=mailbox), to="a-2", content="by id")
    await team.send_message(ctx_with(mailbox=mailbox), to="clara", content="by name")
    assert len(mailbox.collect("a-2")) == 2


async def test_an_unknown_recipient_is_told_who_is_on_the_team():
    mailbox = team.Mailbox({"a-1": "Scout", "a-2": "Clara"})
    with pytest.raises(ToolFailed) as caught:
        await team.send_message(ctx_with(mailbox=mailbox), to="Nobody", content="hi")
    assert caught.value.code == "unknown_recipient"
    # Naming the team turns a dead end into a correction the model can act on.
    assert "Clara" in caught.value.message


async def test_collecting_a_message_empties_the_box():
    mailbox = team.Mailbox({"a-1": "Scout", "a-2": "Clara"})
    await team.send_message(ctx_with(mailbox=mailbox), to="Clara", content="once")
    assert mailbox.collect("a-2")
    # Delivered once. A message that arrives on every turn would have the agent
    # answering the same note forever.
    assert mailbox.collect("a-2") == []


async def test_an_agent_with_no_team_says_so():
    with pytest.raises(ToolFailed) as caught:
        await team.send_message(ctx_with(), to="Clara", content="hi")
    assert caught.value.code == "no_team"


# ---- ask_user ----------------------------------------------------------


async def test_ask_user_waits_for_the_answer_and_returns_it():
    asked: list[tuple[str, str]] = []

    async def asker(agent_id: str, question: str) -> str:
        asked.append((agent_id, question))
        return "use the second one"

    result = await team.ask_user(ctx_with(ask=asker), question="Which source?")
    assert asked == [("a-1", "Which source?")]
    assert "use the second one" in result.content


async def test_a_question_nobody_answered_is_a_failure_not_an_answer():
    async def asker(agent_id: str, question: str) -> None:
        return None  # the mission ended while it was on screen

    with pytest.raises(ToolFailed) as caught:
        await team.ask_user(ctx_with(ask=asker), question="Which one?")
    assert caught.value.code == "unanswered"


# ---- remember / recall -------------------------------------------------


async def test_a_note_survives_into_a_later_recall(db):
    from datetime import UTC, datetime

    from agentd.db.models import Agent

    async with db.session() as session:
        session.add(
            Agent(
                id="a-1",
                name="Scout",
                avatar_config={},
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
        await session.commit()

    ctx = ToolContext(mission_id="m-1", agent_id="a-1", extras={"db": db})
    await memory.remember(ctx, text="The build script lives in scripts/dev.mjs")

    # A different mission entirely: memories belong to the agent, which is the
    # whole reason they are not a scratchpad.
    later = ToolContext(mission_id="m-2", agent_id="a-1", extras={"db": db})
    found = await memory.recall(later, query="where is the build script")
    assert "scripts/dev.mjs" in found.content


async def test_recall_says_it_is_keyword_search_when_it_finds_nothing(db):
    from datetime import UTC, datetime

    from agentd.db.models import Agent

    async with db.session() as session:
        session.add(
            Agent(
                id="a-1",
                name="Scout",
                avatar_config={},
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
        await session.commit()

    ctx = ToolContext(mission_id="m-1", agent_id="a-1", extras={"db": db})
    await memory.remember(ctx, text="The deploy key rotates every Monday")

    found = await memory.recall(ctx, query="credentials schedule")
    # Nothing matched, and the answer says why rather than implying the agent
    # never knew it.
    assert found.details["results"] == 0
    assert "keyword search" in found.content


async def test_one_agent_cannot_recall_another_agents_notes(db):
    from datetime import UTC, datetime

    from agentd.db.models import Agent

    async with db.session() as session:
        for agent_id, name in [("a-1", "Scout"), ("a-2", "Clara")]:
            session.add(
                Agent(
                    id=agent_id,
                    name=name,
                    avatar_config={},
                    created_at=datetime.now(UTC),
                    updated_at=datetime.now(UTC),
                )
            )
        await session.commit()

    await memory.remember(
        ToolContext(mission_id="m", agent_id="a-1", extras={"db": db}),
        text="Scout's private note about the API",
    )
    found = await memory.recall(
        ToolContext(mission_id="m", agent_id="a-2", extras={"db": db}), query="API note"
    )
    assert found.details["results"] == 0


async def test_an_empty_note_is_refused(db):
    ctx = ToolContext(mission_id="m", agent_id="a-1", extras={"db": db})
    with pytest.raises(ToolFailed) as caught:
        await memory.remember(ctx, text="   ")
    assert caught.value.code == "empty_memory"
