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
