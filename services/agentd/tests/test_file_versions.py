"""Keeping what a file held, so a change can be shown rather than counted.

The Files tab says who changed what and when from the log alone. What changed
is not on the log and never was: `write_file.content` and `edit_file`'s strings
are in `redact_fields` and become a byte count before the event is built,
because `mission_events` is append-only for ever.

So the bytes go where the attachments' bytes go — on disk, content-addressed —
and only the digest is in the database.
"""

from __future__ import annotations

import pytest

from agentd.artifacts.versions import MAX_BYTES, VersionStore, root
from agentd.core import config
from agentd.db.models import Mission
from agentd.db.session import Database

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    settings = config.Settings(data_dir=tmp_path / "data")
    monkeypatch.setattr(config, "get_settings", lambda: settings)
    monkeypatch.setattr("agentd.artifacts.versions.get_settings", lambda: settings)
    return settings.data_dir


def write(path, text: str) -> None:
    r"""Write the bytes we mean.

    `Path.write_text` translates \n to \r\n on Windows, which would make every
    byte count in this file depend on the platform it ran on.
    """
    path.write_bytes(text.encode("utf-8"))


async def a_mission(db: Database, workspace) -> str:
    from datetime import UTC, datetime

    async with db.session() as s:
        s.add(
            Mission(
                id="m-v",
                kind="mission",
                goal="build",
                status="running",
                workspace_root=str(workspace),
                started_at=datetime.now(UTC),
            )
        )
        await s.commit()
    return "m-v"


async def test_a_version_is_what_the_file_holds_now(db: Database, tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    write(workspace / "a.ts", "one\ntwo\n")
    mission = await a_mission(db, workspace)

    store = VersionStore(db)
    row = await store.record(
        mission_id=mission, path="a.ts", workspace_root=str(workspace),
        agent_id="dev", event_id="e1",
    )
    assert row is not None
    assert row.bytes == len("one\ntwo\n")
    assert row.lines == 2
    assert store.read_text(row) == "one\ntwo\n"


async def test_every_write_gets_its_own_version(db: Database, tmp_path):
    # The version *is* the change. A file written three times has three.
    workspace = tmp_path / "ws"
    workspace.mkdir()
    mission = await a_mission(db, workspace)
    store = VersionStore(db)

    for n, text in enumerate(["a\n", "a\nb\n", "a\nb\nc\n"]):
        write(workspace / "f.ts", text)
        await store.record(
            mission_id=mission, path="f.ts", workspace_root=str(workspace),
            agent_id="dev", event_id=f"e{n}",
        )

    versions = await store.for_file(mission, "f.ts")
    assert [v.lines for v in versions] == [1, 2, 3]
    # Oldest first: that is the order a diff walks.
    assert store.read_text(versions[0]) == "a\n"
    assert store.read_text(versions[-1]) == "a\nb\nc\n"


async def test_identical_content_is_stored_once(db: Database, tmp_path):
    # Content-addressed: a rewrite that changed nothing, or the same
    # boilerplate in two files, is one blob.
    workspace = tmp_path / "ws"
    workspace.mkdir()
    write(workspace / "a.ts", "same\n")
    write(workspace / "b.ts", "same\n")
    mission = await a_mission(db, workspace)
    store = VersionStore(db)

    first = await store.record(
        mission_id=mission, path="a.ts", workspace_root=str(workspace),
        agent_id="dev", event_id="e1",
    )
    second = await store.record(
        mission_id=mission, path="b.ts", workspace_root=str(workspace),
        agent_id="dev", event_id="e2",
    )
    assert first is not None and second is not None
    assert first.sha256 == second.sha256
    assert len(list(root().iterdir())) == 1


async def test_a_file_that_is_not_there_records_nothing(db: Database, tmp_path):
    # A version is a convenience on top of a change that already happened.
    # Failing to keep one must never turn a successful write into an error.
    workspace = tmp_path / "ws"
    workspace.mkdir()
    mission = await a_mission(db, workspace)
    assert (
        await VersionStore(db).record(
            mission_id=mission, path="gone.ts", workspace_root=str(workspace),
            agent_id="dev", event_id="e1",
        )
        is None
    )


async def test_a_binary_is_not_kept(db: Database, tmp_path):
    # Not something the viewer can diff, and storing it would be storing bytes
    # it can only refuse.
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe")
    mission = await a_mission(db, workspace)
    assert (
        await VersionStore(db).record(
            mission_id=mission, path="logo.png", workspace_root=str(workspace),
            agent_id="dev", event_id="e1",
        )
        is None
    )


async def test_something_enormous_is_not_kept(db: Database, tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    write(workspace / "big.txt", "x" * (MAX_BYTES + 1))
    mission = await a_mission(db, workspace)
    assert (
        await VersionStore(db).record(
            mission_id=mission, path="big.txt", workspace_root=str(workspace),
            agent_id="dev", event_id="e1",
        )
        is None
    )


async def test_a_path_that_escapes_the_workspace_is_refused(db: Database, tmp_path):
    # The same resolver the file tools use. A stored path is data, and data
    # that chooses which file to read is data that has to be checked (§16.2).
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (tmp_path / "secret.txt").write_text("not yours", encoding="utf-8")
    mission = await a_mission(db, workspace)
    assert (
        await VersionStore(db).record(
            mission_id=mission, path="../secret.txt", workspace_root=str(workspace),
            agent_id="dev", event_id="e1",
        )
        is None
    )


async def test_a_version_whose_blob_is_gone_says_so(db: Database, tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    write(workspace / "a.ts", "hello\n")
    mission = await a_mission(db, workspace)
    store = VersionStore(db)
    row = await store.record(
        mission_id=mission, path="a.ts", workspace_root=str(workspace),
        agent_id="dev", event_id="e1",
    )
    assert row is not None
    (root() / row.sha256).unlink()
    with pytest.raises(FileNotFoundError):
        store.read_text(row)
