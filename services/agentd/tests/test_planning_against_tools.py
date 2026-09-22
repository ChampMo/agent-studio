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

**Then it happened again, to the same designer**, which is why there is a third
section below. Task 2 of a five-agent run was "write UX_design_spec.md" and
went to UX/UI, who still had only read tools. With no way to save the file it
tried to hand the whole spec to the developer through `send_message`, and that
call was cut off at max_tokens and never ran. The two agents after it were told
the spec existed and spent four minutes of a fifteen-minute budget running
`find /` for a file that had never been written.

Showing the leader everybody's tools and asking it to match them was the fix
last time. It asked, and the model got it wrong anyway. A prompt is a request;
`_check_tools` is the rule.
"""

from __future__ import annotations

import pytest

from agentd.orchestrator.planner import Plan, _check_tools, _roster_text
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


# ---- and a task that writes a file goes to somebody who can ---------------


#: The team from the run this section was written for.
WEBDEV = RosterSnapshot(
    [
        member(0, "Project Manager (PM)", ["ask_user", "send_message"], leader=True),
        member(1, "UX/UI Designer", ["glob", "grep", "list_dir", "read_file"]),
        member(2, "Developer (Dev)", ["bash", "read_file", "write_file", "edit_file"]),
        member(3, "Business Analyst (BA)", ["read_file", "write_file", "edit_file"]),
    ]
)


def plan(seat: int, instruction: str, task_id: str = "t2") -> Plan:
    return Plan.model_validate(
        {
            "tasks": [
                {
                    "id": task_id,
                    "title": "a task",
                    "assignee_seat": seat,
                    "instruction": instruction,
                }
            ]
        }
    )


def test_the_run_that_motivated_the_check_is_rejected():
    """Task 2 of WEBDEV, word for word."""
    problem = _check_tools(
        plan(
            1,
            "Read BA_user_journey.md. Then write UX_design_spec.md in the "
            "current workspace. It must define exact CSS values.",
        ),
        WEBDEV,
    )
    assert problem is not None
    # Names the task, who cannot do it, and where it should go instead — a
    # correction the model can act on without guessing.
    assert "t2" in problem
    assert "UX/UI Designer" in problem
    assert "[2, 3]" in problem
    assert "write_file" in problem


def test_a_writer_may_write():
    assert (
        _check_tools(
            plan(2, "Implement the landing page as index.html and styles.css."),
            WEBDEV,
        )
        is None
    )


@pytest.mark.parametrize(
    "instruction",
    [
        "Read BA_user_journey.md and report what it says.",
        "Inspect index.html, styles.css and main.js, then list what is wrong.",
        "Summarise UX_design_spec.md for the team.",
    ],
)
def test_reading_a_file_needs_no_write_tool(instruction: str):
    """The other half of the rule, and the reason the verb has to be there.

    A check that fired on any instruction naming a file would move every review
    task onto the members that can write — the opposite of what a team is for,
    and it would put the QA pass on the developer who wrote the thing.
    """
    assert _check_tools(plan(1, instruction), WEBDEV) is None


def test_a_task_with_no_file_in_it_is_left_alone():
    assert _check_tools(plan(1, "Write up your findings and send them."), WEBDEV) is None


def test_it_is_silent_when_nobody_can_write():
    """A correction nobody can satisfy would burn every attempt and fail the
    mission outright — worse than the problem it prevents.

    So it fires only where reassigning is actually available, which is exactly
    where it is the fix.
    """
    read_only = RosterSnapshot(
        [
            member(0, "Lead", ["send_message"], leader=True),
            member(1, "Reader", ["read_file", "grep"]),
            member(2, "Other reader", ["read_file"]),
        ]
    )
    assert _check_tools(plan(1, "Write REPORT.md with your findings."), read_only) is None


def test_edit_file_alone_counts_as_being_able_to_write():
    """`edit_file` puts bytes on disk. A team carrying it and not `write_file`
    is not a team that cannot write."""
    editors = RosterSnapshot(
        [
            member(0, "Lead", ["send_message"], leader=True),
            member(1, "Reader", ["read_file"]),
            member(2, "Editor", ["read_file", "edit_file"]),
        ]
    )
    problem = _check_tools(plan(1, "Update NOTES.md with the new numbers."), editors)
    assert problem is not None
    assert "[2]" in problem


@pytest.mark.parametrize(
    "instruction",
    [
        "Write UX_design_spec.md in the workspace.",
        "Create INDEX.md listing every file.",
        "Save the results as results.json.",
        "Produce a report.md summarising the run.",
        "Build the page as index.html.",
        "Update styles.css with the new tokens.",
    ],
)
def test_the_ordinary_ways_of_asking_for_a_file(instruction: str):
    assert _check_tools(plan(1, instruction), WEBDEV) is not None
