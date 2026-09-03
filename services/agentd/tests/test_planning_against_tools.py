"""What the leader can see when it hands out work, and who it can hand to.

Both found by one parallel run. The plan was correct about *what* to do and
correct about what could run at the same time — and then gave "create INDEX.md"
to the UX/UI Designer, whose tools are `ask_user, glob, grep, list_dir,
read_file, send_message`.

It could not write the file. It spent five turns trying to hand the work on —
`implementer`, `Dev`, `Developer`, `PM`, `Project Manager` — and every one was
refused, because the roster names are `Developer (Dev)` and `Project Manager
(PM)` and the mailbox only matched in full. The file was never written and the
run still ended `completed`.

Two separate causes, and neither was the model being careless:

* the roster the leader plans against never said who could do what;
* a teammate's name had to be typed exactly, parenthetical and all.
"""

from __future__ import annotations

import pytest

from agentd.orchestrator.planner import _roster_text
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember
from agentd.tools.team import Ambiguous, Mailbox


def member(seat: int, name: str, tools: list[str], *, leader: bool = False):
    return SnapshotMember(
        agent_id=f"a-{seat}",
        name=name,
        seat_index=seat,
        role_in_team="leader" if leader else "member",
        system_prompt="s",
        provider_id="p",
        model="m",
        sampling=None,
        tools=tools,
        avatar_config={"body": "slim"},
    )


# ---- the leader can see who can do what ---------------------------------


def test_the_roster_names_each_members_tools():
    text = _roster_text(
        RosterSnapshot(
            [
                member(0, "Pat", [], leader=True),
                member(1, "Dev", ["write_file", "edit_file"]),
                member(2, "Ux", ["read_file"]),
            ]
        )
    )
    # Without this the leader is choosing an assignee from a name and a title.
    assert "write_file" in text and "edit_file" in text
    assert "read_file" in text


def test_a_member_with_no_tools_is_said_to_have_none():
    # Silence would read as "unknown", and the leader would guess.
    text = _roster_text(RosterSnapshot([member(0, "Pat", [], leader=True)]))
    assert "no tools" in text


def test_the_leader_is_still_marked_as_not_taking_tasks():
    text = _roster_text(
        RosterSnapshot([member(0, "Pat", ["send_message"], leader=True), member(1, "Dev", ["bash"])])
    )
    assert "you do not take tasks" in text


# ---- a teammate's name does not have to be typed in full ----------------


def box() -> Mailbox:
    return Mailbox(
        {
            "a-1": "Developer (Dev)",
            "a-2": "Project Manager (PM)",
            "a-3": "Tester (QA Engineer)",
        }
    )


def test_the_full_name_still_works():
    assert box().resolve("Developer (Dev)") == "a-1"


@pytest.mark.parametrize("typed", ["Developer", "developer", "Dev", "  dev  "])
def test_the_shortenings_a_model_actually_writes_now_resolve(typed: str):
    # Every one of these was refused on the run that found this.
    assert box().resolve(typed) == "a-1"


def test_a_parenthetical_alias_resolves():
    assert box().resolve("PM") == "a-2"
    assert box().resolve("QA Engineer") == "a-3"


def test_an_agent_id_still_works():
    assert box().resolve("a-2") == "a-2"


def test_a_name_that_fits_nobody_is_still_nobody():
    # The tool reports this with the real names, which is how the run above
    # knew what it had to work with.
    assert box().resolve("Marketing") is None


def test_a_prefix_beats_a_mere_mention():
    # "Dev" starts "Developer (Dev)" and is only contained in the other, so the
    # narrower reading wins instead of raising.
    mailbox = Mailbox({"a-1": "Developer (Dev)", "a-2": "Head of Developer Relations"})
    assert mailbox.resolve("Developer") == "a-1"


def test_two_teammates_that_both_fit_still_raise():
    # The rule that has not moved: never guess between people. Delivering to
    # the wrong one and telling the sender it worked is the worst failure here.
    mailbox = Mailbox({"a-1": "Mara Vale", "a-2": "Mara Quinn"})
    with pytest.raises(Ambiguous):
        mailbox.resolve("Mara")
