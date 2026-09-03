"""The four things a command can do that no control on screen could.

Each of these existed as a mechanism and had no way in. `Mailbox.post` has
taken a single recipient since M8 and the user could only broadcast;
`_run_team` has taken `require_approval` since M6 and only `start_mission` ever
passed it; `file_versions` has kept every version since M10 and nothing ever
read one back; the roster snapshot has been copyable all along.

So these tests are mostly about the *edges* rather than the happy path: who a
note reaches when it is addressed, what happens when the name fits two people,
and what a rewind refuses to claim it can do.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from agentd.artifacts.rewind import Rewinder
from agentd.artifacts.versions import VersionStore
from agentd.db.models import FileVersion, Mission, MissionEvent
from agentd.tools.team import Ambiguous, Mailbox


# ---- @Name: who a note actually reaches ---------------------------------


def test_a_bare_note_still_goes_to_everyone():
    """The behaviour that already worked, pinned. Addressing is an addition;
    a note with no name must not quietly become a message to one person."""
    box = Mailbox({"a1": "Wren", "a2": "Bo"})
    assert sorted(box.recipients()) == ["a1", "a2"]


def test_a_name_resolves_the_way_send_message_resolves_it():
    box = Mailbox({"a1": "Developer (Dev)", "a2": "Bo"})
    # Exact, then prefix, then contains — the same order an agent's own
    # `send_message` uses, because two answers to "who is Dev" is one too many.
    assert box.resolve("Developer (Dev)") == "a1"
    assert box.resolve("Developer") == "a1"
    assert box.resolve("dev") == "a1"


def test_two_teammates_who_both_fit_is_a_question_not_a_guess():
    """Delivering to the wrong person and reporting success is the worst
    failure available here — the sender is told it worked."""
    box = Mailbox({"a1": "Mara", "a2": "Mara"})
    with pytest.raises(Ambiguous):
        box.resolve("Mara")


def test_a_name_nobody_answers_to_resolves_to_nothing():
    box = Mailbox({"a1": "Wren"})
    assert box.resolve("Halden") is None


def test_an_addressed_note_reaches_one_mailbox_only():
    box = Mailbox({"a1": "Wren", "a2": "Bo"})
    box.post(sender="you", recipient="a1", content="check that file again")
    assert box.collect("a1") == [("you", "check that file again")]
    # The other three should not be reading an instruction that is not theirs.
    assert box.collect("a2") == []


# ---- /rewind ------------------------------------------------------------


async def seed(db, *, mission_id="m-rw", workspace):
    """A run with two writes to one file, a minute apart."""
    t0 = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)
    async with db.session() as s:
        s.add(
            Mission(
                id=mission_id,
                kind="mission",
                team_id="t1",
                goal="g",
                status="ended",
                budget={},
                roster_snapshot=[{"agentId": "a1"}],
                workspace_root=str(workspace),
                started_at=t0,
            )
        )
        for seq, minute in ((1, 0), (2, 2)):
            s.add(
                MissionEvent(
                    id=f"e{seq}",
                    mission_id=mission_id,
                    seq=seq,
                    ts=t0 + timedelta(minutes=minute),
                    v=1,
                    type="agent.message",
                    payload={},
                )
            )
        await s.commit()
    return t0


@pytest.mark.asyncio
async def test_a_rewind_puts_the_earlier_version_back(db, tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    t0 = await seed(db, workspace=workspace)
    store = VersionStore(db)

    target = workspace / "notes.md"
    target.write_text("first\n", encoding="utf-8")
    first = await store.record(
        mission_id="m-rw", path="notes.md", workspace_root=str(workspace),
        agent_id="a1", event_id="e1",
    )
    assert first is not None
    # Stamped before the cutoff; the second one after it.
    async with db.session() as s:
        row = await s.get(FileVersion, first.id)
        row.created_at = t0
        await s.commit()

    target.write_text("second, which was a mistake\n", encoding="utf-8")
    second = await store.record(
        mission_id="m-rw", path="notes.md", workspace_root=str(workspace),
        agent_id="a1", event_id="e2",
    )
    async with db.session() as s:
        row = await s.get(FileVersion, second.id)
        row.created_at = t0 + timedelta(minutes=3)
        await s.commit()

    result = await Rewinder(db).apply(
        mission_id="m-rw", seq=1, workspace_root=str(workspace)
    )
    assert result["restored"] == ["notes.md"]
    assert target.read_text(encoding="utf-8") == "first\n"


@pytest.mark.asyncio
async def test_the_state_before_a_rewind_is_kept(db, tmp_path):
    """A rewind is itself a change, so it is undoable by rewinding again — and
    the Files tab shows it rather than the file changing under it."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    t0 = await seed(db, workspace=workspace)
    store = VersionStore(db)

    target = workspace / "notes.md"
    target.write_text("first\n", encoding="utf-8")
    first = await store.record(
        mission_id="m-rw", path="notes.md", workspace_root=str(workspace),
        agent_id="a1", event_id="e1",
    )
    async with db.session() as s:
        (await s.get(FileVersion, first.id)).created_at = t0
        await s.commit()
    target.write_text("second\n", encoding="utf-8")

    before = len(await store.for_file("m-rw", "notes.md"))
    await Rewinder(db).apply(mission_id="m-rw", seq=1, workspace_root=str(workspace))
    after = await store.for_file("m-rw", "notes.md")
    # What was there, plus what is there now.
    assert len(after) == before + 2
    assert store.read_text(after[-2]) == "second\n"
    assert after[-1].agent_id is None  # no agent wrote it


@pytest.mark.asyncio
async def test_a_file_created_after_the_point_is_reported_never_deleted(db, tmp_path):
    """Deleting something we have no copy of is not an undo, it is a second
    kind of loss."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    t0 = await seed(db, workspace=workspace)
    store = VersionStore(db)

    later = workspace / "extra.md"
    later.write_text("written after the point\n", encoding="utf-8")
    row = await store.record(
        mission_id="m-rw", path="extra.md", workspace_root=str(workspace),
        agent_id="a1", event_id="e2",
    )
    async with db.session() as s:
        (await s.get(FileVersion, row.id)).created_at = t0 + timedelta(minutes=5)
        await s.commit()

    plan = await Rewinder(db).plan(mission_id="m-rw", seq=1)
    entry = next(f for f in plan.restores if f.path == "extra.md")
    assert entry.action == "created_after"

    await Rewinder(db).apply(mission_id="m-rw", seq=1, workspace_root=str(workspace))
    assert later.exists()


@pytest.mark.asyncio
async def test_the_plan_says_what_it_will_do_before_it_does_it(db, tmp_path):
    """Shown first on purpose: a rewind only knows what the file tools wrote,
    and the person has to be able to see that before agreeing to it."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    t0 = await seed(db, workspace=workspace)
    store = VersionStore(db)
    (workspace / "a.md").write_text("one\n", encoding="utf-8")
    row = await store.record(
        mission_id="m-rw", path="a.md", workspace_root=str(workspace),
        agent_id="a1", event_id="e1",
    )
    async with db.session() as s:
        (await s.get(FileVersion, row.id)).created_at = t0
        await s.commit()
    (workspace / "a.md").write_text("two\n", encoding="utf-8")

    plan = (await Rewinder(db).plan(mission_id="m-rw", seq=1)).to_json()
    assert plan["willChange"] == 1
    assert plan["files"][0]["path"] == "a.md"
    assert plan["files"][0]["action"] == "restore"


@pytest.mark.asyncio
async def test_a_run_that_wrote_nothing_rewinds_to_nothing(db, tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    await seed(db, workspace=workspace)
    plan = await Rewinder(db).plan(mission_id="m-rw", seq=1)
    assert plan.restores == []
    assert plan.changes == []
