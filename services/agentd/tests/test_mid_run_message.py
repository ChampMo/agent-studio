"""Saying something to a team that is already working (§7.1).

The composer used to be disabled for the whole run, with "stop the run to send
something new" underneath — so noticing a mistake thirty seconds in meant
throwing the run away and paying for it again.

What this is *not* is an interrupt. Nothing can reach a model mid-reply, and a
UI that implied otherwise would be lying about the system. The note goes into
the same mailbox teammates use and is collected when the next task starts, which
is a real place and a real moment — and the wording everywhere says so.
"""

from __future__ import annotations

import pytest

from agentd.agents.runner import USER_SENDER, MissionNotRunning
from agentd.tools.team import Mailbox


def test_the_user_reads_as_a_person_in_a_teammate_s_inbox():
    # Rendered straight into the next agent's instruction as "<sender> says:",
    # so the label has to be something an agent can read, not an id.
    box = Mailbox({"a1": "Mara"})
    assert box.name_of(USER_SENDER) == "The user"


def test_every_member_is_a_recipient():
    box = Mailbox({"a1": "Mara", "a2": "Ilse"})
    assert sorted(box.recipients()) == ["a1", "a2"]


def test_a_note_reaches_whoever_runs_next_and_only_once():
    box = Mailbox({"a1": "Mara", "a2": "Ilse"})
    for agent_id in box.recipients():
        box.post(sender=USER_SENDER, recipient=agent_id, content="use green")

    # Each collects it when their task starts...
    assert box.collect("a1") == [(USER_SENDER, "use green")]
    assert box.collect("a2") == [(USER_SENDER, "use green")]
    # ...and `collect` empties the box, so nobody is told twice.
    assert box.collect("a1") == []
    assert box.collect("a2") == []


async def test_a_note_to_a_mission_that_is_not_running_is_refused(db, bus):
    from agentd.agents.runner import MissionRunner

    runner = MissionRunner(db, bus)
    with pytest.raises(MissionNotRunning):
        await runner.note("mission-nope", "are you there?")


async def test_an_empty_note_is_refused_before_anything_is_published(db, bus):
    # Publishing an empty `user.message` would put a blank bubble on a record
    # that is append-only forever (§9.3).
    from agentd.agents.runner import MissionRunner

    runner = MissionRunner(db, bus)
    with pytest.raises(ValueError):
        await runner.note("mission-nope", "   ")
