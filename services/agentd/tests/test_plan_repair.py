"""One possible assignee is not a choice, so nobody should be asked to make it.

A real run died with

    planning_failed: task t5 writes a file ('implement the DESIGN.md') but
    seat 3 (Sorrel) cannot: it has read_file, list_dir, glob, grep,
    send_message. Give it to one of seats [1], who hold write_file or
    edit_file.

**Seats [1].** One seat. The app knew the only legal answer, spent every
attempt asking a model to guess it, and then threw the run away in front of
somebody who had done nothing but pick a team and describe a job.
"""

from __future__ import annotations

from agentd.orchestrator.planner import (
    Plan,
    Task,
    _check_tools,
    _repair_tools,
)
from agentd.teams.snapshot import RosterSnapshot, SnapshotMember

READ_ONLY = ["read_file", "list_dir", "glob", "grep", "send_message"]
WRITES = ["write_file", "edit_file", "read_file"]


def member(seat: int, name: str, tools: list[str], role: str = "member"):
    return SnapshotMember(
        agent_id=f"a{seat}",
        name=name,
        title="",
        role="",
        seat_index=seat,
        role_in_team=role,
        system_prompt="",
        provider_id="p",
        model="m",
        sampling=None,
        tools=tools,
        autonomy="ask_dangerous",
        avatar_config={},
    )


def team(*members) -> RosterSnapshot:
    return RosterSnapshot(list(members), workspace_root="C:/ws")


def plan_writing_to(seat: int) -> Plan:
    return Plan(
        tasks=[
            Task(
                id="t5",
                title="Implement the design",
                assignee_seat=seat,
                instruction="implement the DESIGN.md from the spec",
            )
        ]
    )


ONE_WRITER = team(
    member(0, "Pepper", [], role="leader"),
    member(1, "Juniper", WRITES),
    member(3, "Sorrel", READ_ONLY),
)


def test_the_only_writer_is_given_the_work_instead_of_the_run_dying():
    plan = plan_writing_to(3)
    moved = _repair_tools(plan, ONE_WRITER)

    assert plan.tasks[0].assignee_seat == 1
    assert len(moved) == 1
    # Said in its own words, because "Sorrel was handed a writing task and
    # cannot write" is worth knowing about your own team.
    assert "Sorrel" in moved[0] and "Juniper" in moved[0]
    # And nothing is left for the model to be asked about.
    assert _check_tools(plan, ONE_WRITER) is None


def test_a_plan_that_was_already_right_is_left_alone():
    plan = plan_writing_to(1)
    assert _repair_tools(plan, ONE_WRITER) == []
    assert plan.tasks[0].assignee_seat == 1


def test_a_task_that_writes_nothing_is_not_moved():
    plan = Plan(
        tasks=[
            Task(
                id="t1",
                title="Review",
                assignee_seat=3,
                instruction="read DESIGN.md and report what it says",
            )
        ]
    )
    assert _repair_tools(plan, ONE_WRITER) == []
    assert plan.tasks[0].assignee_seat == 3


def test_two_writers_is_a_real_choice_and_still_goes_back_to_the_model():
    two = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        member(2, "Moss", WRITES),
        member(3, "Sorrel", READ_ONLY),
    )
    plan = plan_writing_to(3)
    # Picking between two people who can both do it is the leader's job.
    assert _repair_tools(plan, two) == []
    assert plan.tasks[0].assignee_seat == 3
    problem = _check_tools(plan, two)
    assert problem and "Sorrel" in problem


def test_a_team_where_nobody_can_write_is_neither_repaired_nor_nagged():
    # The correction would be impossible to obey, and burning every attempt on
    # it is worse than the problem it describes.
    none = team(
        member(0, "Pepper", [], role="leader"),
        member(3, "Sorrel", READ_ONLY),
    )
    plan = plan_writing_to(3)
    assert _repair_tools(plan, none) == []
    assert _check_tools(plan, none) is None


# --- routing on what a task says it needs, not on what its prose looks like ---
#
# The v0.3.6 release check ended `failed` over work it had actually done. Its
# plan had a task titled "Shell-verify DESIGN.md contents", handed to seat 1,
# who holds no `bash`, while seat 2 carried one. The assignee then reported
# that "the workspace exposes no shell" — a misassignment reading, to whoever
# opened the run, as a broken app.
#
# The repair above could not have caught it: it only knew about writing, and
# no regex over that title says "needs a shell" rather than "needs a reader".
# So a task declares its own tools and routing is exact.

SHELL = ["bash", "read_file", "list_dir", "grep"]


def shell_task(seat: int, needs=("bash",)) -> Plan:
    return Plan(
        tasks=[
            Task(
                id="t2",
                title="Shell-verify DESIGN.md contents",
                assignee_seat=seat,
                instruction="Check DESIGN.md against NOTES.md with a command.",
                needs_tools=list(needs),
            )
        ]
    )


def test_the_release_check_failure_is_repaired():
    """The real shape: one shell, and the task went to somebody else."""
    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        member(2, "Moss", SHELL),
    )
    plan = shell_task(1)

    moved = _repair_tools(plan, snapshot)

    assert plan.tasks[0].assignee_seat == 2
    assert len(moved) == 1
    assert "bash" in moved[0] and "Moss" in moved[0] and "Juniper" in moved[0]
    # Repaired, so there is nothing left to argue about.
    assert _check_tools(plan, snapshot) is None


def test_two_teammates_with_the_shell_is_a_choice_not_a_repair():
    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        member(2, "Moss", SHELL),
        member(3, "Sorrel", SHELL),
    )
    plan = shell_task(1)

    assert _repair_tools(plan, snapshot) == []
    assert plan.tasks[0].assignee_seat == 1, "a real choice must not be made for them"

    problem = _check_tools(plan, snapshot)
    assert problem is not None
    assert "bash" in problem
    assert "[2, 3]" in problem


def test_a_team_with_no_shell_at_all_is_left_alone():
    """Silence is the point: a correction nobody can obey burns every attempt
    and fails the mission outright, which is worse than the misassignment."""
    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        member(2, "Sorrel", READ_ONLY),
    )
    plan = shell_task(1)

    assert _repair_tools(plan, snapshot) == []
    assert _check_tools(plan, snapshot) is None
    assert plan.tasks[0].assignee_seat == 1


def test_each_task_is_routed_on_its_own_needs():
    """What the team-wide version could not do.

    It asked whether the team had exactly one writer and moved everything
    there if so. Two tasks needing two different tools each have a single —
    and different — legal assignee, and both have to land in the right place.
    """
    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        member(2, "Moss", SHELL),
    )
    plan = Plan(
        tasks=[
            Task(id="t1", title="Write it", assignee_seat=2,
                 instruction="Save the result.", needs_tools=["write_file"]),
            Task(id="t2", title="Check it", assignee_seat=1,
                 instruction="Verify the result.", needs_tools=["bash"]),
        ]
    )

    moved = _repair_tools(plan, snapshot)

    assert [t.assignee_seat for t in plan.tasks] == [1, 2]
    assert len(moved) == 2


def test_every_declared_tool_has_to_be_held_not_just_one_of_them():
    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        # bash but no writing, so it cannot do a task that needs both
        member(2, "Moss", SHELL),
        member(3, "Rowan", [*SHELL, "write_file"]),
    )
    plan = Plan(
        tasks=[
            Task(id="t1", title="Build and record", assignee_seat=1,
                 instruction="Run it, then save what it said.",
                 needs_tools=["bash", "write_file"]),
        ]
    )

    _repair_tools(plan, snapshot)
    assert plan.tasks[0].assignee_seat == 3, "only Rowan holds both"


def test_a_tool_id_that_does_not_exist_is_a_correction():
    """Dropping it silently would switch the check off for that task without
    telling anybody — the quiet half of the failure this field exists to fix.
    """
    from agentd.orchestrator.planner import _unknown_tools

    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
    )
    plan = Plan(
        tasks=[
            Task(id="t1", title="Run the tests", assignee_seat=1,
                 instruction="Run the tests.", needs_tools=["run_tests"]),
        ]
    )

    problem = _unknown_tools(plan, snapshot)
    assert problem is not None
    assert "run_tests" in problem
    assert "write_file" in problem, "it should say what this team actually holds"

    plan.tasks[0].needs_tools = ["write_file"]
    assert _unknown_tools(plan, snapshot) is None


def test_a_plan_that_declares_nothing_behaves_exactly_as_before():
    """The field is optional and the prose backstop still carries the file
    case, so a model that ignores it gets the old behaviour unchanged."""
    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        member(2, "Sorrel", READ_ONLY),
    )
    plan = Plan(
        tasks=[
            Task(id="t1", title="Design", assignee_seat=2,
                 instruction="Write DESIGN.md with the colour in it."),
        ]
    )
    assert plan.tasks[0].needs_tools is None

    moved = _repair_tools(plan, snapshot)
    assert plan.tasks[0].assignee_seat == 1
    assert len(moved) == 1


# --- what the plan declared beats what its prose looks like -----------------
#
# Verified live, and the live run is where this came from. With routing fixed,
# the shell task went to the teammate holding `bash` and ran it — and the round
# was still recorded `failed`, because the same regex is asked a second
# question: does this task owe a file? Both remaining tasks matched it from a
# *negated* sentence:
#
#     t2 -> 'edit DESIGN.md'                            ("do not edit DESIGN.md")
#     t3 -> 'edit either file. Report back: what NOTES.md'  ("Do not edit either file.")
#
# A review told explicitly not to write was recorded as owing a file and
# failed for not producing one. The work had been done correctly.

REVIEW = "Read both files. Do not edit either file. Report back: what NOTES.md says."


def test_a_review_that_says_do_not_edit_is_not_a_writing_task():
    from agentd.orchestrator.planner import _WRITES_A_FILE, owes_a_file

    task = Task(id="t3", title="Review", assignee_seat=1,
                instruction=REVIEW, needs_tools=["read_file"])

    # The prose really does look like writing — that is the whole problem.
    assert _WRITES_A_FILE.search(REVIEW) is not None
    # And the declaration settles it.
    assert owes_a_file(task) is False


def test_a_declared_review_is_not_moved_to_the_writer():
    """The first version of the routing fix added the prose guess on top of
    the declaration, so this task was moved to the only teammate who could
    write — for a job whose instruction forbids writing."""
    snapshot = team(
        member(0, "Pepper", [], role="leader"),
        member(1, "Juniper", WRITES),
        member(2, "Sorrel", READ_ONLY),
    )
    plan = Plan(tasks=[Task(id="t3", title="Review", assignee_seat=2,
                            instruction=REVIEW, needs_tools=["read_file"])])

    assert _repair_tools(plan, snapshot) == []
    assert plan.tasks[0].assignee_seat == 2, "Sorrel can read; nothing to repair"


def test_the_prose_still_decides_when_the_plan_said_nothing():
    """Unchanged for a model that ignores the field — including the negated
    sentence, which stays wrong. Reading prose is a guess either way; what
    changed is that a declaration is no longer overruled by one."""
    from agentd.orchestrator.planner import owes_a_file

    declared_nothing = Task(id="t1", title="Build", assignee_seat=1,
                            instruction="Create DESIGN.md with the colour.")
    assert owes_a_file(declared_nothing) is True


def test_a_task_that_declares_a_file_tool_still_owes_a_file():
    from agentd.orchestrator.planner import owes_a_file

    assert owes_a_file(Task(id="t1", title="Build", assignee_seat=1,
                            instruction="Do the thing.",
                            needs_tools=["write_file"])) is True
    assert owes_a_file(Task(id="t2", title="Run", assignee_seat=1,
                            instruction="Do the thing.",
                            needs_tools=["bash"])) is False


def test_owes_a_file_reads_a_plain_dict_too():
    """The graph asks after the plan has become dicts, and one function has to
    answer both or the two readers drift (§2.1)."""
    from agentd.orchestrator.planner import owes_a_file

    assert owes_a_file({"instruction": REVIEW, "needs_tools": ["read_file"]}) is False
    assert owes_a_file({"instruction": "Create DESIGN.md now."}) is True
    assert owes_a_file({}) is False
