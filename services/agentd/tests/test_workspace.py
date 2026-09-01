"""Choosing a workspace (§16.2, §12 M8 criterion 7).

The picker is in the window and the window can be driven; the checks are here.
What this covers is the difference between the two severities — a system folder
is refused outright, a broad-but-real choice is allowed and said out loud —
because getting that backwards makes the app either useless or dangerous.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from agentd.tools.workspace import (
    RECENT_LIMIT,
    WorkspaceRejected,
    WorkspaceStore,
    check,
)


def test_an_ordinary_project_folder_passes(tmp_path: Path):
    project = tmp_path / "my-project"
    project.mkdir()
    result = check(str(project))
    assert Path(result.path) == project.resolve()
    assert result.warnings == []


def test_a_folder_that_does_not_exist_is_refused(tmp_path: Path):
    with pytest.raises(WorkspaceRejected):
        check(str(tmp_path / "nope"))


def test_a_file_is_not_a_workspace(tmp_path: Path):
    target = tmp_path / "notes.txt"
    target.write_text("x", encoding="utf-8")
    with pytest.raises(WorkspaceRejected):
        check(str(target))


def test_nothing_chosen_is_refused():
    for empty in ["", "   "]:
        with pytest.raises(WorkspaceRejected):
            check(empty)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows system paths")
def test_windows_system_directories_are_refused():
    for path in [os.environ.get("SystemRoot", r"C:\Windows"), r"C:\Program Files"]:
        if not Path(path).is_dir():
            continue
        with pytest.raises(WorkspaceRejected):
            check(path)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows system paths")
def test_a_folder_inside_a_system_directory_is_refused():
    inside = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    if not inside.is_dir():
        pytest.skip("no System32 on this machine")
    with pytest.raises(WorkspaceRejected):
        check(str(inside))


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX system paths")
def test_posix_system_directories_are_refused():
    for path in ["/etc", "/usr"]:
        if not Path(path).is_dir():
            continue
        with pytest.raises(WorkspaceRejected):
            check(path)


def test_the_home_directory_is_allowed_but_warned_about():
    # Not refused: it is a real choice someone occasionally means. Said out
    # loud, because it is almost never what "my project folder" meant.
    result = check(str(Path.home()))
    assert "home_directory" in [w.code for w in result.warnings]


@pytest.mark.skipif(sys.platform != "win32", reason="drive roots")
def test_a_drive_root_is_warned_about():
    result = check("C:\\")
    assert "drive_root" in [w.code for w in result.warnings]


async def test_the_recent_list_is_newest_first_and_bounded(db):
    store = WorkspaceStore(db)
    for i in range(RECENT_LIMIT + 5):
        await store.remember(f"/tmp/project-{i}")

    recent = await store.recent()
    assert len(recent) == RECENT_LIMIT
    # The most recently used first, and the oldest dropped entirely.
    assert recent[0]["path"] == f"/tmp/project-{RECENT_LIMIT + 4}"
    assert all(row["path"] != "/tmp/project-0" for row in recent)


async def test_choosing_the_same_folder_again_moves_it_up(db):
    store = WorkspaceStore(db)
    await store.remember("/tmp/first")
    await store.remember("/tmp/second")
    await store.remember("/tmp/first")

    recent = await store.recent()
    assert [row["path"] for row in recent] == ["/tmp/first", "/tmp/second"]


async def test_the_list_says_whether_a_folder_is_still_there(db, tmp_path: Path):
    store = WorkspaceStore(db)
    real = tmp_path / "still-here"
    real.mkdir()
    await store.remember(str(real))
    await store.remember(str(tmp_path / "deleted-since"))

    by_path = {row["path"]: row for row in await store.recent()}
    assert by_path[str(real)]["exists"] is True
    # A folder that has been moved or deleted should look different in the
    # picker rather than failing when it is chosen.
    assert by_path[str(tmp_path / "deleted-since")]["exists"] is False
