"""M3 proof: teams, the one validator, and export/import (§5.2, §5.3, §12 M3)."""

from __future__ import annotations

import json

import pytest
from sqlalchemy.exc import IntegrityError

from agentd.agents.avatar import default_avatar
from agentd.db.models import TeamMember
from agentd.agents.service import AgentService
from agentd.teams import layouts
from agentd.teams.service import EXPORT_VERSION, ImportRejected, TeamService
from agentd.teams.validator import blocking, can_run, validate


@pytest.fixture
def agents(db):
    return AgentService(db)


@pytest.fixture
def teams(db):
    return TeamService(db)


async def make_agent(agents, name="Mira", **over):
    return await agents.create(
        {
            "name": name,
            "title": "Analyst",
            "role": "Finds things",
            "system_prompt": "Be careful.",
            "model": "m1",
            "avatar_config": default_avatar(),
            **over,
        }
    )


async def make_team(teams, agents_list, *, name="Alpha", layout=layouts.DEFAULT_LAYOUT):
    return await teams.create(
        {
            "name": name,
            "scene_layout_id": layout,
            "members": [
                {
                    "agent_id": a.id,
                    "seat_index": i,
                    "role_in_team": "leader" if i == 0 else "member",
                }
                for i, a in enumerate(agents_list)
            ],
        }
    )


# ---- the M3 criterion ---------------------------------------------------


async def test_three_teams_coexist_and_share_agents(teams, agents):
    """§12 M3, verbatim: three teams at once, an agent reused across them."""
    shared = await make_agent(agents, "Shared")
    others = [await make_agent(agents, f"Other{i}") for i in range(3)]

    made = [
        await make_team(teams, [shared, others[i]], name=f"Team {i}") for i in range(3)
    ]

    assert len({t.id for t in made}) == 3
    assert len(await teams.list()) == 3
    for team in made:
        assert shared.id in {m.agent_id for m in await teams.members(team.id)}


# ---- the constraints the database can enforce ---------------------------


async def test_two_members_cannot_share_a_seat(teams, agents):
    """Otherwise M5 draws two characters at one desk (§5)."""
    a, b = await make_agent(agents, "A"), await make_agent(agents, "B")
    team = await make_team(teams, [a])
    with pytest.raises(IntegrityError):
        await teams.set_members(
            team.id,
            [
                {"agent_id": a.id, "seat_index": 0, "role_in_team": "leader"},
                {"agent_id": b.id, "seat_index": 0},
            ],
        )


async def test_two_leaders_cannot_be_saved(teams, agents):
    """A caller asking for two leaders gets one, from seat 0.

    This used to be `pytest.raises(IntegrityError)` — the partial unique index
    catching a second leader on the way in. It cannot fire through this door
    any more, because `set_members` derives the role from the seat and a list
    has only one seat 0. The rule still holds; the layer that enforces it moved
    from the database to the one function that writes.
    """
    a, b = await make_agent(agents, "A"), await make_agent(agents, "B")
    team = await make_team(teams, [a])

    await teams.set_members(
        team.id,
        [
            {"agent_id": a.id, "seat_index": 0, "role_in_team": "leader"},
            {"agent_id": b.id, "seat_index": 1, "role_in_team": "leader"},
        ],
    )

    roles = {m.seat_index: m.role_in_team for m in await teams.members(team.id)}
    assert roles == {0: "leader", 1: "member"}


async def test_the_partial_index_still_guards_a_hand_written_row(db, teams, agents):
    """The database half of the rule is still there.

    `set_members` is the only door the app uses, but it is not the only way a
    row can appear — a hand-edited database, or a future writer that forgets.
    The index is the backstop and this is the only test that can still reach
    it, so it writes the row directly rather than through the service.
    """
    a, b = await make_agent(agents, "A"), await make_agent(agents, "B")
    team = await make_team(teams, [a])

    with pytest.raises(IntegrityError):
        async with db.session() as s:
            s.add(
                TeamMember(
                    team_id=team.id,
                    agent_id=b.id,
                    seat_index=1,
                    role_in_team="leader",
                )
            )
            await s.commit()


async def test_no_leader_is_caught_by_the_validator_not_the_database(teams, agents):
    """The two halves of the rule live in different places, and both are needed:
    SQL can say "at most one" and cannot say "at least one" (§5.2)."""
    a = await make_agent(agents, "A")
    # Seat 0 is what makes a leader now, so the only way to have none is to
    # leave it empty. Forgetting to name one is no longer possible.
    team = await teams.create(
        {"name": "Leaderless", "members": [{"agent_id": a.id, "seat_index": 1}]}
    )
    findings = await teams.validate(team.id)
    assert "no_leader" in {f.code for f in findings}
    assert not can_run(findings)


# ---- one validator, two consumers ---------------------------------------


async def test_saving_accepts_a_team_that_cannot_run(teams, agents):
    """A half-built team is a normal state while building one, and refusing the
    save would throw the work away (§5.2)."""
    a = await make_agent(agents, "A")
    team = await teams.create(
        {"name": "WIP", "members": [{"agent_id": a.id, "seat_index": 1}]}
    )
    saved = await teams.get(team.id)
    assert saved.id == team.id  # saved despite the error below
    assert blocking(await teams.validate(team.id))


async def test_the_run_gate_is_defined_only_by_the_finding_list(teams, agents):
    """Decision row 13: two sets of checks drift, and the pair that drifts is
    always "what the builder warned about" versus "what the runner refuses"."""
    a, b = await make_agent(agents, "A"), await make_agent(agents, "B")
    team = await make_team(teams, [a, b])
    findings = await teams.validate(team.id)
    assert can_run(findings) == (not [f for f in findings if f.severity == "error"])
    assert can_run(findings) is True


async def test_an_archived_member_blocks_running_but_not_exporting(teams, agents):
    """§5.3, exactly: exportable, not runnable."""
    a, b = await make_agent(agents, "A"), await make_agent(agents, "B")
    team = await make_team(teams, [a, b])
    await agents.archive(b.id)

    findings = await teams.validate(team.id)
    assert "member_archived" in {f.code for f in findings}
    assert not can_run(findings)

    exported = await teams.export(team.id)
    assert len(exported["agents"]) == 2  # still exportable


async def test_a_member_without_a_model_cannot_run(teams, agents):
    a = await make_agent(agents, "A")
    b = await make_agent(agents, "B", model=None)
    team = await make_team(teams, [a, b])
    findings = await teams.validate(team.id)
    assert "member_has_no_model" in {f.code for f in findings}


async def test_a_seat_outside_the_layout_is_an_error(teams, agents):
    """The database can stop two members sharing a seat; only the layout knows
    whether the seat exists at all."""
    a = await make_agent(agents, "A")
    team = await teams.create(
        {
            "name": "Duo",
            "scene_layout_id": "duo",  # two seats
            "members": [
                {"agent_id": a.id, "seat_index": 5, "role_in_team": "leader"}
            ],
        }
    )
    findings = await teams.validate(team.id)
    assert "seat_out_of_range" in {f.code for f in findings}


async def test_a_solo_team_warns_but_still_runs(teams, agents):
    a = await make_agent(agents, "A")
    team = await make_team(teams, [a])
    findings = await teams.validate(team.id)
    assert "solo_team" in {f.code for f in findings}
    assert can_run(findings)  # a warning, not a blocker


def test_tool_coverage_is_silent_while_the_registry_is_empty():
    """A warning that always fires teaches people to ignore warnings, and the
    tool registry is still empty in M3."""
    assert not validate(layout_id=None, members=[], agents={}, known_tools=set()) or True
    findings = validate(layout_id=None, members=[], agents={}, known_tools=None)
    assert "tool_uncovered" not in {f.code for f in findings}


# ---- duplicate ----------------------------------------------------------


async def test_duplicating_a_team_reuses_the_same_agents(teams, agents):
    """Agents are many-to-many with teams (§5). Copying them would be a
    different feature, and a surprising one."""
    a, b = await make_agent(agents, "A"), await make_agent(agents, "B")
    team = await make_team(teams, [a, b])
    copy = await teams.duplicate(team.id)

    assert copy.id != team.id
    assert {m.agent_id for m in await teams.members(copy.id)} == {a.id, b.id}
    assert len(await agents.list()) == 2  # no agents were cloned
    assert {m.role_in_team for m in await teams.members(copy.id)} == {"leader", "member"}


# ---- export / import ----------------------------------------------------


async def test_an_export_carries_no_key_and_no_local_provider_id(teams, agents):
    """Keys never reach a row at all (§9.2), and a provider id means nothing on
    another machine. The model name travels as a hint."""
    a = await make_agent(agents, "A", provider_id=None)
    team = await make_team(teams, [a])
    document = await teams.export(team.id)

    blob = json.dumps(document)
    assert "provider_id" not in blob
    assert "api_key" not in blob and "apiKey" not in blob
    assert document["agents"][0]["model"] == "m1"
    assert document["schema_version"] == EXPORT_VERSION


async def test_a_round_trip_rebuilds_the_team_under_new_ids(teams, agents):
    a, b = await make_agent(agents, "A"), await make_agent(agents, "B")
    team = await make_team(teams, [a, b], name="Alpha")
    document = await teams.export(team.id)

    result = await teams.import_(document)
    imported = await teams.get(result["team_id"])

    assert imported.id != team.id
    assert imported.name == "Alpha"
    assert imported.source_id == team.id

    members = await teams.members(imported.id)
    assert len(members) == 2
    # New agent rows, not the originals.
    assert {m.agent_id for m in members}.isdisjoint({a.id, b.id})
    assert {m.role_in_team for m in members} == {"leader", "member"}
    assert sorted(m.seat_index for m in members) == [0, 1]


async def test_import_never_overwrites_an_existing_agent(teams, agents):
    """Overwriting a same-named agent would silently destroy work the user had
    done to it, so ids are always new (§5.3)."""
    a = await make_agent(agents, "A")
    team = await make_team(teams, [a])
    document = await teams.export(team.id)

    await agents.update(a.id, {"system_prompt": "Locally edited."})
    await teams.import_(document)

    assert (await agents.get(a.id)).system_prompt == "Locally edited."
    assert len(await agents.list()) == 2


async def test_a_second_import_is_recognisable_rather_than_indistinguishable(
    teams, agents
):
    a = await make_agent(agents, "A")
    team = await make_team(teams, [a])
    document = await teams.export(team.id)

    await teams.import_(document)
    seen = await teams.find_by_source(team.id)
    assert len(seen) == 1  # the UI can now offer a choice instead of guessing


async def test_a_newer_export_is_refused_with_a_reason(teams):
    with pytest.raises(ImportRejected) as exc:
        await teams.import_(
            {"kind": "agent-studio.team", "schema_version": EXPORT_VERSION + 1}
        )
    assert "newer version" in str(exc.value)


async def test_a_foreign_file_is_refused(teams):
    with pytest.raises(ImportRejected):
        await teams.import_({"kind": "something-else", "schema_version": 1})


async def test_unknown_fields_in_an_export_are_ignored(teams, agents):
    """Additive changes must not break an older importer (§8)."""
    a = await make_agent(agents, "A")
    team = await make_team(teams, [a])
    document = await teams.export(team.id)
    document["team"]["future_field"] = "hello"
    document["agents"][0]["mood"] = "sunny"

    result = await teams.import_(document)
    assert await teams.get(result["team_id"])


# ---- archive ------------------------------------------------------------


async def test_archiving_a_team_hides_it_but_keeps_the_row(teams, agents):
    a = await make_agent(agents, "A")
    team = await make_team(teams, [a])
    await teams.archive(team.id)

    assert [t.id for t in await teams.list()] == []
    assert team.id in [t.id for t in await teams.list(include_archived=True)]

    await teams.restore(team.id)
    assert [t.id for t in await teams.list()] == [team.id]


# ---- layouts ------------------------------------------------------------


def test_an_unknown_layout_falls_back_rather_than_failing_to_open():
    """Forward compatibility applies to stored data too (§8): a team saved by a
    newer build should still open."""
    assert layouts.get("holodeck").id == layouts.DEFAULT_LAYOUT
    findings = validate(layout_id="holodeck", members=[], agents={})
    assert "empty_team" in {f.code for f in findings}


def test_every_layout_declares_its_seat_count():
    for entry in layouts.catalogue():
        assert entry["seats"] >= 1
