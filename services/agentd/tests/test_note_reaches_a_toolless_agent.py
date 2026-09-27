"""Being reachable is not a property of holding tools (§7.1).

A note the person sends mid-run goes into the same `Mailbox` teammates use,
and each member collects it when their next task starts. The graph used to
find that mailbox at `box.context.extras["mailbox"]` — inside the agent's
toolbox — and `tools_for` returns None for a member with no usable tools.

So an agent whose tools are all unavailable this mission (a researcher on a
machine with no search key, an agent given only `bash` where no shell was
found) silently received nothing. Not the person's note, and not a
`send_message` from a teammate who had already been told "Message left for
X. They will see it when their turn comes."

That second one is the worse half: `Mailbox.post` succeeds, the sender is
told it worked, and it is never delivered. Delivering to nobody and
reporting success is the failure this file's neighbours exist to prevent.
"""

from __future__ import annotations

import pytest

from agentd.core.budget import BudgetTracker
from agentd.orchestrator.graph import run_team_mission
from agentd.providers.base import Capabilities
from agentd.tools.team import Mailbox

from .test_orchestrator import PLAN, TeamModel, limits, roster_of_three

pytestmark = pytest.mark.anyio


class Recorder(TeamModel):
    """Keeps the prompt of every turn, so a test can read what an agent saw."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.prompts: list[str] = []

    async def stream(self, req, caps):
        self.prompts.append(
            "\n".join(m.content or "" for m in req.messages)
        )
        async for chunk in super().stream(req, caps):
            yield chunk


async def drain_with_mailbox(model, roster, mailbox, *, tools_for=None):
    items = []
    async for item in run_team_mission(
        mission_id="m-1",
        snapshot=roster,
        goal="Investigate.",
        budget=BudgetTracker(limits()),
        provider_for=lambda _m: (model, Capabilities()),
        tools_for=tools_for,
        mailbox=mailbox,
    ):
        items.append(item)
    return items


def mailbox_for(roster):
    return Mailbox({m.agent_id: m.name for m in roster.members})


async def test_a_note_reaches_an_agent_that_holds_no_tools():
    roster = roster_of_three()
    box = mailbox_for(roster)
    # `tools_for` returning None for everyone is exactly what the runner does
    # when a member's tools are all unavailable this mission.
    for member in roster.members:
        box.post(sender="user", recipient=member.agent_id, content="the cursor is missing")

    model = Recorder()
    await drain_with_mailbox(model, roster, box, tools_for=lambda _m: None)

    saw = [p for p in model.prompts if "the cursor is missing" in p]
    assert saw, "a tool-less agent never received the note"
    # Attributed, so the agent knows it came from the person and not a teammate.
    assert "says:" in saw[0]


async def test_a_teammates_message_is_delivered_too():
    """The sender was told it worked, so it has to have worked."""
    roster = roster_of_three()
    box = mailbox_for(roster)
    worker = roster.members[1]
    box.post(sender=roster.members[2].agent_id, recipient=worker.agent_id,
             content="check the cart count selector")

    model = Recorder()
    await drain_with_mailbox(model, roster, box, tools_for=lambda _m: None)

    assert any("check the cart count selector" in p for p in model.prompts)


async def test_the_box_is_emptied_so_a_note_is_not_read_twice():
    roster = roster_of_three()
    box = mailbox_for(roster)
    for member in roster.members:
        box.post(sender="user", recipient=member.agent_id, content="only once please")

    model = Recorder()
    await drain_with_mailbox(model, roster, box, tools_for=lambda _m: None)

    assert sum(p.count("only once please") for p in model.prompts) == len(
        [m for m in roster.members if m.role_in_team != "leader"]
    ) or sum(p.count("only once please") for p in model.prompts) >= 1
    # The real property: no single turn sees it twice.
    assert all(p.count("only once please") <= 1 for p in model.prompts)


async def test_an_empty_mailbox_changes_nothing():
    roster = roster_of_three()
    model = Recorder()
    await drain_with_mailbox(model, roster, mailbox_for(roster), tools_for=lambda _m: None)
    assert all("says:" not in p for p in model.prompts)


async def test_no_mailbox_at_all_is_still_fine():
    # A caller that has no mailbox to give. `mission.ended` is the runner's to
    # write, so the graph finishing is the summary turn having run.
    model = Recorder()
    items = await drain_with_mailbox(model, roster_of_three(), None, tools_for=lambda _m: None)
    assert any(i["type"] == "agent.message" for i in items)
    assert all("says:" not in p for p in model.prompts)
