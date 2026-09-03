"""The files an agent produced are the thing a run is for (§5, §12 M6).

`artifact.created` was published from exactly one place in the whole codebase —
the `final-answer.md` written when a run completed — so the Files tab read
**Files 0** over a workspace holding twenty files and a Next.js app that built.
Every assessment of what a team had actually made had to be done in Explorer.

A workspace file is recorded rather than copied. `write_text` puts a file under
the app's artifact root and owns it from then on; this points at a file in the
folder the user chose, which the agents keep editing and the user can open in
an editor. A copy taken at write time would be a stale duplicate claiming to be
the work, and there would be two answers to "what did this run produce" (§2.1).

The honest cost of that is a row that can outlive its file, and it is said
plainly rather than crashed on.
"""

from __future__ import annotations

import pytest

from agentd.artifacts.store import ArtifactRejected, ArtifactStore, kind_for
from agentd.db.models import Mission
from agentd.db.session import Database

pytestmark = pytest.mark.anyio


async def a_mission(db: Database, workspace) -> str:
    from datetime import UTC, datetime

    async with db.session() as s:
        s.add(
            Mission(
                id="m-ws",
                kind="mission",
                goal="build it",
                status="running",
                workspace_root=str(workspace),
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()
    return "m-ws"


# ---- what kind of file it is -------------------------------------------


def test_a_source_file_is_code_and_a_readme_is_a_document():
    assert kind_for("app/page.tsx") == "code"
    assert kind_for("lib/data.ts") == "code"
    assert kind_for("NOTES.md") == "doc"
    assert kind_for("public/logo.svg") == "image"


def test_something_unrecognised_is_a_document_rather_than_a_guess():
    # Calling an unknown extension "code" would be a guess written onto the
    # record. "doc" is what the viewer can always render.
    assert kind_for("weird.qqq") == "doc"
    assert kind_for("Makefile") == "doc"


# ---- recording ----------------------------------------------------------


async def test_a_written_file_becomes_something_the_app_can_list(
    db: Database, tmp_path
):
    workspace = tmp_path / "ws"
    (workspace / "app").mkdir(parents=True)
    (workspace / "app" / "page.tsx").write_text("export default 1", encoding="utf-8")
    mission_id = await a_mission(db, workspace)

    store = ArtifactStore(db)
    artifact, is_new = await store.note_workspace_file(
        mission_id=mission_id,
        agent_id="a1",
        relative="app/page.tsx",
        workspace_root=str(workspace),
    )
    assert is_new
    assert artifact.source == "workspace"
    assert artifact.kind == "code"
    assert artifact.bytes == len("export default 1")
    assert [a.path for a in await store.for_mission(mission_id)] == ["app/page.tsx"]


async def test_the_same_file_written_twice_is_one_file(db: Database, tmp_path):
    # Otherwise the timeline says a file was created four times, which would be
    # describing four files.
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "NOTES.md").write_text("first", encoding="utf-8")
    mission_id = await a_mission(db, workspace)
    store = ArtifactStore(db)

    _, first = await store.note_workspace_file(
        mission_id=mission_id, agent_id="a1", relative="NOTES.md",
        workspace_root=str(workspace),
    )
    (workspace / "NOTES.md").write_text("second, and longer", encoding="utf-8")
    again, second = await store.note_workspace_file(
        mission_id=mission_id, agent_id="a1", relative="NOTES.md",
        workspace_root=str(workspace),
    )

    assert first is True and second is False
    assert len(await store.for_mission(mission_id)) == 1
    # And the size followed the file rather than being frozen at the first write.
    assert again.bytes == len("second, and longer")


async def test_a_file_that_cannot_be_measured_is_still_listed(db: Database, tmp_path):
    # The size is a convenience. A run whose output does not appear because one
    # `stat` failed would be the worse failure.
    workspace = tmp_path / "ws"
    workspace.mkdir()
    mission_id = await a_mission(db, workspace)
    artifact, _ = await ArtifactStore(db).note_workspace_file(
        mission_id=mission_id, agent_id="a1", relative="gone.md",
        workspace_root=str(workspace),
    )
    assert artifact.bytes == 0


# ---- reading it back ----------------------------------------------------


async def test_reading_resolves_against_the_mission_workspace(db: Database, tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "NOTES.md").write_text("hello", encoding="utf-8")
    mission_id = await a_mission(db, workspace)
    store = ArtifactStore(db)
    artifact, _ = await store.note_workspace_file(
        mission_id=mission_id, agent_id="a1", relative="NOTES.md",
        workspace_root=str(workspace),
    )
    assert await store.read_text(artifact, str(workspace)) == "hello"


async def test_a_stored_path_that_escapes_the_workspace_is_refused(
    db: Database, tmp_path
):
    # A stored path is data, and data that decides which file to open is data
    # that has to be checked — this process holds the user's keychain (§9.1).
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (tmp_path / "secret.txt").write_text("not yours", encoding="utf-8")
    mission_id = await a_mission(db, workspace)
    store = ArtifactStore(db)
    artifact, _ = await store.note_workspace_file(
        mission_id=mission_id, agent_id="a1", relative="ok.md",
        workspace_root=str(workspace),
    )
    artifact.path = "../secret.txt"
    with pytest.raises(ArtifactRejected):
        await store.read_text(artifact, str(workspace))


async def test_a_file_the_user_deleted_says_so(db: Database, tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "NOTES.md").write_text("hello", encoding="utf-8")
    mission_id = await a_mission(db, workspace)
    store = ArtifactStore(db)
    artifact, _ = await store.note_workspace_file(
        mission_id=mission_id, agent_id="a1", relative="NOTES.md",
        workspace_root=str(workspace),
    )
    (workspace / "NOTES.md").unlink()
    with pytest.raises(ArtifactRejected, match="missing"):
        await store.read_text(artifact, str(workspace))
