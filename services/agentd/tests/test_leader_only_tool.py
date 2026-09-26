"""A tool only the leader carries is a tool nobody can use (§5.2).

`_assignable()` excludes the leader whenever the team has workers — the leader
supervises — and the two turns a leader does take, planning and summarising, are
given no toolbox at all. So a tool held only by the leader is on the roster,
counted as covered by `tool_uncovered`, and dead.

Found by a real run. A research team's leader was the only member with
`web_search`; every task went to the one worker; the worker improvised by
calling `read_file` on a URL, failed, and wrote a confident, well-formatted
document **entirely from the model's memory**. It said so — the system prompt
made it say so — but nothing in the app did, because from the outside the team
was correctly equipped.
"""

from __future__ import annotations

import pytest

from agentd.agents.avatar import default_avatar
from agentd.agents.service import AgentService
from agentd.teams import layouts
from agentd.teams.service import TeamService
from agentd.teams.validator import can_run

pytestmark = pytest.mark.anyio


@pytest.fixture
def agents(db):
    return AgentService(db)


@pytest.fixture
def teams(db):
    return TeamService(db)


async def make_agent(agents, name, tools):
    return await agents.create(
        {
            "name": name,
            "title": "t",
            "role": "r",
            "system_prompt": "s",
            "model": "m1",
            "tools": tools,
            "avatar_config": default_avatar(),
        }
    )


async def make_team(teams, members, name="Alpha"):
    return await teams.create(
        {
            "name": name,
            "scene_layout_id": layouts.DEFAULT_LAYOUT,
            "members": [
                {
                    "agent_id": a.id,
                    "seat_index": i,
                    "role_in_team": "leader" if i == 0 else "member",
                }
                for i, a in enumerate(members)
            ],
        }
    )


def codes(findings):
    return {f.code for f in findings}


def finding(findings, code):
    return next(f for f in findings if f.code == code)


async def test_a_tool_only_the_leader_holds_is_reported(agents, teams):
    lead = await make_agent(agents, "Wren", ["web_search", "web_fetch"])
    worker = await make_agent(agents, "Bo", ["write_file", "read_file"])
    team = await make_team(teams, [lead, worker])
    found = await teams.validate(team.id)

    assert "leader_only_tool" in codes(found)
    message = finding(found, "leader_only_tool").message
    assert "Wren" in message
    # Named, so the fix is obvious rather than a puzzle.
    assert "web_search" in message and "web_fetch" in message


async def test_the_tools_have_to_go_to_workers_not_just_move(agents, teams):
    """Swapping the roles does not help, and finding that out is the point.

    Written expecting silence and it reported `write_file` instead — correctly:
    a leader holding *any* tool cannot use it, so moving the web tools down and
    leaving the file tools up just changes which one is dead.

    What the warning is actually asking for is a leader that carries nothing.
    """
    lead = await make_agent(agents, "Bo", ["write_file"])
    worker = await make_agent(agents, "Wren", ["web_search", "web_fetch"])
    team = await make_team(teams, [lead, worker])
    assert "leader_only_tool" in codes(await teams.validate(team.id))


async def test_a_leader_that_carries_nothing_is_the_shape_that_works(agents, teams):
    # Leader coordinates; the work — and every tool — lives with the workers.
    lead = await make_agent(agents, "Coordinator", ["send_message"])
    searcher = await make_agent(agents, "Wren", ["web_search", "web_fetch"])
    writer = await make_agent(agents, "Bo", ["write_file", "read_file"])
    team = await make_team(teams, [lead, searcher, writer])
    assert "leader_only_tool" not in codes(await teams.validate(team.id))


async def test_a_tool_the_leader_shares_with_a_worker_is_fine(agents, teams):
    lead = await make_agent(agents, "Wren", ["web_search", "read_file"])
    worker = await make_agent(agents, "Bo", ["web_search", "read_file"])
    team = await make_team(teams, [lead, worker])
    assert "leader_only_tool" not in codes(await teams.validate(team.id))


async def test_a_solo_team_is_not_warned(agents, teams):
    # A team of one assigns work to itself — `_assignable()` says so — so the
    # leader's tools are reachable and there is nothing to report.
    solo = await make_agent(agents, "Halden", ["bash", "read_file"])
    team = await make_team(teams, [solo])
    assert "leader_only_tool" not in codes(await teams.validate(team.id))


async def test_send_message_alone_is_not_worth_a_warning(agents, teams):
    # It is how a leader talks to its team, and it is used from turns that are
    # not tasks. Warning about it would fire on almost every sensible team.
    lead = await make_agent(agents, "Wren", ["send_message"])
    worker = await make_agent(agents, "Bo", ["write_file"])
    team = await make_team(teams, [lead, worker])
    assert "leader_only_tool" not in codes(await teams.validate(team.id))


async def test_it_is_a_warning_not_a_launch_gate(agents, teams):
    # The team runs; it just does the work without the tool. Refusing to launch
    # would be this file deciding how people arrange a team (§5.2).
    lead = await make_agent(agents, "Wren", ["web_search"])
    worker = await make_agent(agents, "Bo", ["write_file"])
    team = await make_team(teams, [lead, worker])
    found = await teams.validate(team.id)
    assert finding(found, "leader_only_tool").severity == "warn"
    assert can_run(found) is True


async def test_write_file_without_edit_file_is_reported(agents, teams):
    """The pair that cost a real run most of its budget.

    PARADOX.ART's QA agent held `write_file` and not `edit_file`. `write_file`
    refuses to overwrite - deliberately, since overwriting is deleting work
    nobody saw a diff of - so once it had put down the first 22KB of a test
    plan there was no tool left that could add to it. It finished the file
    through `cat >> ... <<EOF` heredocs, two of which were truncated by the
    command size limit and repaired with `sed -i`.

    The sharpest part is that `write_file`'s own failure message says "use
    edit_file to change a file that is there" - a correction naming a tool the
    agent does not have.
    """
    lead = await make_agent(agents, "Coordinator", ["send_message"])
    qa = await make_agent(agents, "Rowan", ["write_file", "read_file", "bash"])
    team = await make_team(teams, [lead, qa])
    found = await teams.validate(team.id)

    assert "write_without_edit" in codes(found)
    message = finding(found, "write_without_edit").message
    assert "Rowan" in message
    # Names the fix, not just the fault.
    assert "edit_file" in message


async def test_holding_both_says_nothing(agents, teams):
    lead = await make_agent(agents, "Coordinator", ["send_message"])
    dev = await make_agent(agents, "Basil", ["write_file", "edit_file", "read_file"])
    team = await make_team(teams, [lead, dev])
    assert "write_without_edit" not in codes(await teams.validate(team.id))


async def test_a_reader_that_writes_nothing_says_nothing(agents, teams):
    # No write_file, so there is no half of a pair to be missing.
    lead = await make_agent(agents, "Coordinator", ["send_message"])
    reader = await make_agent(agents, "Poppy", ["read_file", "grep", "glob"])
    team = await make_team(teams, [lead, reader])
    assert "write_without_edit" not in codes(await teams.validate(team.id))
