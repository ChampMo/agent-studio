"""A model staffs a team; the validator still decides whether it may run.

The test that matters here is the last one. A model asked whether a team has
web access looks at the roster and says yes — every tool present, on a real
member, spelled correctly. It cannot see that the member it chose is the
leader, and that a leader with workers is never assigned a task, so the tools
are on somebody who will never use them. This project shipped exactly that team
and watched it answer a research question from memory.

So `POST /teams/suggest` runs `validate()` over what the model proposed and
returns the findings beside it. `test_the_gate_catches_what_the_model_cannot`
is that arrangement, written down: a proposal the model was perfectly happy
with, coming back with `leader_only_tool` on it.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from agentd.db.models import Agent
from agentd.providers.base import Capabilities, DoneChunk, TextChunk, Usage
from agentd.teams.team_gen import (
    TeamGenerationFailed,
    review_team,
    suggest_team,
)
from agentd.teams.validator import validate


def agent(agent_id: str, name: str, tools: list[str]) -> Agent:
    now = datetime.now(UTC)
    return Agent(
        id=agent_id,
        name=name,
        title="Specialist",
        role="does things",
        backstory="",
        personality_traits=[],
        system_prompt="",
        tools=tools,
        avatar_config={"body": "slim", "hair": "bun", "outfit": "blazer", "palette": "teal"},
        provider_id="p1",
        model="m1",
        autonomy="ask_dangerous",
        total_missions=0,
        created_at=now,
        updated_at=now,
    )


ROSTER = [
    agent("a1", "Pace", ["send_message"]),
    agent("a2", "Ilse", ["read_file", "write_file", "send_message"]),
    agent("a3", "Rook", ["web_search", "web_fetch", "send_message"]),
]

GOOD = {
    "layoutId": "open_desks",
    "members": [
        {"agentId": "a1", "seat": 0, "role": "leader", "addTools": [], "why": "plans it"},
        {"agentId": "a2", "seat": 1, "role": "worker", "addTools": ["glob"], "why": "writes it"},
    ],
    "gaps": [],
}


class ScriptedModel:
    kind = "fake"

    def __init__(self, replies):
        self._replies = [r if isinstance(r, tuple) else (r, "stop") for r in replies]
        self.requests = []

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        self.requests.append(req)
        reply, stop = self._replies.pop(0) if self._replies else ("{}", "stop")
        yield TextChunk(reply)
        yield DoneChunk(stop, Usage(50, 120))

    async def aclose(self):
        return None


async def propose(model, agents=None, **kw):
    return await suggest_team(
        provider=model,
        caps=Capabilities(structured_output="json_object"),
        model="m1",
        brief="Write a short report about SQLite and save it as a file.",
        agents=ROSTER if agents is None else agents,
        **kw,
    )


# ---- the closed catalogue, three ways it can be broken -------------------


async def test_a_valid_proposal_is_accepted_first_time():
    result = await propose(ScriptedModel([json.dumps(GOOD)]))
    assert result.attempts == 1
    assert result.recovered_from == []
    assert [m.agent_id for m in result.proposal.members] == ["a1", "a2"]
    assert result.proposal.members[1].add_tools == ["glob"]


async def test_an_agent_that_does_not_exist_is_refused_and_corrected():
    """The one failure a schema cannot catch: the id is a well-formed string
    and there is nobody behind it. Only the caller holds the roster."""
    invented = {
        **GOOD,
        "members": [
            {"agentId": "a1", "seat": 0, "role": "leader", "addTools": [], "why": ""},
            {"agentId": "a9", "seat": 1, "role": "worker", "addTools": [], "why": ""},
        ],
    }
    model = ScriptedModel([json.dumps(invented), json.dumps(GOOD)])
    result = await propose(model)
    assert result.attempts == 2
    assert "a9" in result.recovered_from[0]
    # The correction names the real ids rather than saying "invalid".
    assert "a2" in model.requests[1].messages[-1].content


async def test_an_invented_tool_is_refused():
    bad = {
        **GOOD,
        "members": [
            {"agentId": "a1", "seat": 0, "role": "leader", "addTools": [], "why": ""},
            {
                "agentId": "a2",
                "seat": 1,
                "role": "worker",
                "addTools": ["search_web"],
                "why": "",
            },
        ],
    }
    result = await propose(ScriptedModel([json.dumps(bad), json.dumps(GOOD)]))
    assert "search_web" in result.recovered_from[0]


async def test_a_seat_the_layout_does_not_have_is_refused():
    over = {
        **GOOD,
        "layoutId": "duo",
        "members": [
            {"agentId": "a1", "seat": 0, "role": "leader", "addTools": [], "why": ""},
            {"agentId": "a2", "seat": 7, "role": "worker", "addTools": [], "why": ""},
        ],
    }
    result = await propose(ScriptedModel([json.dumps(over), json.dumps(GOOD)]))
    assert "out of range" in result.recovered_from[0]


async def test_two_leaders_is_refused():
    two = {
        **GOOD,
        "members": [
            {"agentId": "a1", "seat": 0, "role": "leader", "addTools": [], "why": ""},
            {"agentId": "a2", "seat": 1, "role": "leader", "addTools": [], "why": ""},
        ],
    }
    result = await propose(ScriptedModel([json.dumps(two), json.dumps(GOOD)]))
    assert "one leader" in result.recovered_from[0]


async def test_the_same_person_twice_is_refused():
    """Teammates are addressed by name, so two of anyone is a message
    delivered to the wrong one with the sender told it worked."""
    twice = {
        **GOOD,
        "members": [
            {"agentId": "a2", "seat": 0, "role": "leader", "addTools": [], "why": ""},
            {"agentId": "a2", "seat": 1, "role": "worker", "addTools": [], "why": ""},
        ],
    }
    result = await propose(ScriptedModel([json.dumps(twice), json.dumps(GOOD)]))
    assert "seated twice" in result.recovered_from[0]


async def test_giving_up_carries_the_whole_trail():
    model = ScriptedModel(["not json", "still not json", "nope"])
    with pytest.raises(TeamGenerationFailed) as caught:
        await propose(model)
    # Three attempts, all reported: "it failed" is not something a user can act
    # on, and the trail says whether the model was close.
    assert len(caught.value.attempts) == 3
    assert caught.value.usage.output_tokens == 360


async def test_truncation_buys_room_rather_than_advice():
    """The tokens went on reasoning before the first visible character, so
    "answer more briefly" is a correction about output the model never reached
    — the lesson the planner already carries."""
    model = ScriptedModel([("{\"layoutId\": \"stu", "length"), json.dumps(GOOD)])
    result = await propose(model)
    assert result.attempts == 2
    assert model.requests[1].max_tokens > model.requests[0].max_tokens


# ---- what the model is shown --------------------------------------------


async def test_the_prompt_shows_who_exists_and_what_they_carry():
    """A leader choosing an assignee from a name and a title gave "create
    INDEX.md" to somebody who could not write files, and spent five turns
    trying to hand the work on. The tools have to be on the line."""
    model = ScriptedModel([json.dumps(GOOD)])
    await propose(model)
    system = model.requests[0].system
    assert "a3  Rook" in system
    assert "web_search" in system
    assert "open_desks" in system


async def test_only_the_tools_this_machine_can_run_are_offered():
    model = ScriptedModel([json.dumps(GOOD)])
    await propose(model, available_tools=["read_file", "write_file", "send_message"])
    system = model.requests[0].system
    # The roster line still says what Rook carries — that is a fact about the
    # agent — but the catalogue to choose from does not offer it.
    assert "web_search    " not in system


# ---- the whole point ----------------------------------------------------


def test_the_gate_catches_what_the_model_cannot():
    """A proposal the model is perfectly happy with, that would run without
    ever reaching the web.

    Every tool is present, on a real member, spelled correctly, and the seats
    and the leader are all legal — so nothing in `suggest_team`'s own checking
    fires. `leader_only_tool` fires, because it knows that a leader with
    workers is never assigned a task.
    """
    from agentd.db.models import TeamMember

    members = [
        TeamMember(
            team_id="proposed",
            agent_id="a3",  # carries web_search and web_fetch
            seat_index=0,
            role_in_team="leader",
            overrides=None,
        ),
        TeamMember(
            team_id="proposed",
            agent_id="a2",
            seat_index=1,
            role_in_team="member",
            overrides=None,
        ),
    ]
    findings = validate(
        layout_id="open_desks",
        members=members,
        agents={a.id: a for a in ROSTER},
        known_tools={"web_search", "web_fetch", "read_file", "write_file", "send_message"},
    )
    codes = [f.code for f in findings]
    assert "leader_only_tool" in codes
    # And it names the tools, because "something is wrong with this team" is
    # not a thing anyone can fix.
    note = next(f for f in findings if f.code == "leader_only_tool")
    assert "web_search" in note.message


# ---- the review, which is an opinion and says so ------------------------


REVIEW = {
    "verdict": "They can do it, but nobody can read the existing files.",
    "notes": [
        {"about": "Ilse", "kind": "missing_tool", "message": "Needs grep to find them."},
    ],
}


async def review(model, members=None):
    return await review_team(
        provider=model,
        caps=Capabilities(structured_output="json_object"),
        model="m1",
        brief="Audit the copy in this workspace.",
        members=members
        or [(ROSTER[0], "leader", ["send_message"]), (ROSTER[1], "worker", ["write_file"])],
    )


async def test_a_review_comes_back_as_prose_and_notes():
    result = await review(ScriptedModel([json.dumps(REVIEW)]))
    assert result.review.notes[0].kind == "missing_tool"
    assert result.review.notes[0].about == "Ilse"


async def test_an_unrecognised_note_kind_becomes_a_plain_note():
    """§8, applied to a model rather than to a wire format. An unknown kind
    would reach the screen with no colour, no icon and no meaning — and it is
    still a real remark, so it is kept and shown as what it is."""
    odd = {
        "verdict": "Fine.",
        "notes": [{"about": "", "kind": "catastrophic", "message": "Something."}],
    }
    result = await review(ScriptedModel([json.dumps(odd)]))
    assert result.review.notes[0].kind == "note"
    assert result.review.notes[0].message == "Something."


async def test_a_review_never_carries_a_severity():
    """A `warn` from a model would sit in the same list as a `warn` from
    `validator.py` and be read as the same kind of claim. One is a rule about
    how work is distributed; the other is an opinion about a paragraph."""
    result = await review(ScriptedModel([json.dumps(REVIEW)]))
    assert not hasattr(result.review.notes[0], "severity")
    assert "severity" not in result.review.notes[0].model_dump()


async def test_the_review_reads_the_tools_the_run_would_use():
    """Effective tools, not the agent's own: a per-team `tool_subset` is what
    the run actually uses, and reviewing the agent's full set would be reading
    a different team from the one that runs (§5.1)."""
    model = ScriptedModel([json.dumps(REVIEW)])
    await review(
        model,
        members=[(ROSTER[0], "leader", []), (ROSTER[1], "worker", ["read_file"])],
    )
    system = model.requests[0].system
    assert "tools: read_file" in system
    assert "tools: none" in system
