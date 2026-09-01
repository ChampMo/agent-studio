"""Every way out of the workspace, actually attempted (§16.3, §12 M8 criterion 1).

These are not assertions about intent. Each test builds a real escape on the
real filesystem and checks that the resolver refuses it — because the resolver
is the only thing between a model that has read a web page and the rest of the
user's disk (§2.7: there is no sandbox behind it).

The Windows cases matter most and are the ones most easily forgotten: a junction
is not a symlink, and `PROGRA~1` is not a different directory from
`Program Files`. Both are skipped rather than faked on platforms that cannot
create them.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from pathlib import Path

import pytest

from agentd.tools.paths import PathRejected, canonical, is_within, resolve_within

WINDOWS = sys.platform == "win32"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A workspace with a file in it, and a secret next to it — outside."""
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text("print('hi')\n", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("the key\n", encoding="utf-8")
    return root


def test_an_ordinary_path_resolves(workspace: Path):
    resolved = resolve_within(workspace, "src/main.py")
    assert resolved.read_text(encoding="utf-8").startswith("print")
    assert is_within(canonical(workspace), resolved)


def test_a_path_that_does_not_exist_yet_resolves(workspace: Path):
    # write_file creates files. Refusing every path that is not already there
    # would make the tool useless.
    resolved = resolve_within(workspace, "src/new/deeper/notes.md")
    assert is_within(canonical(workspace), resolved)


@pytest.mark.parametrize(
    "attempt",
    [
        "../secret.txt",
        "../../secret.txt",
        "src/../../secret.txt",
        "./src/./../../secret.txt",
        "src/../..",
        "..",
        # A name that starts like a directory inside, then leaves it.
        "src/../../workspace2/secret.txt",
    ],
)
def test_dot_dot_cannot_climb_out(workspace: Path, attempt: str):
    with pytest.raises(PathRejected):
        resolve_within(workspace, attempt)


def test_an_absolute_path_outside_is_refused(workspace: Path, tmp_path: Path):
    # Joining an absolute path silently discards the root, so the containment
    # check is what has to catch this one.
    with pytest.raises(PathRejected):
        resolve_within(workspace, str(tmp_path / "secret.txt"))


def test_an_absolute_path_inside_is_allowed(workspace: Path):
    # grep and glob hand back absolute paths; refusing them outright would mean
    # a result the agent cannot then read.
    resolved = resolve_within(workspace, str(workspace / "src" / "main.py"))
    assert resolved.name == "main.py"


def test_a_sibling_with_a_shared_prefix_is_outside(tmp_path: Path):
    # `/data/workspace2` starts with `/data/workspace`. A string prefix check
    # would call this containment.
    (tmp_path / "workspace").mkdir()
    (tmp_path / "workspace2").mkdir()
    (tmp_path / "workspace2" / "secret.txt").write_text("x", encoding="utf-8")
    with pytest.raises(PathRejected):
        resolve_within(tmp_path / "workspace", str(tmp_path / "workspace2" / "secret.txt"))


def test_a_symlink_pointing_out_is_refused(workspace: Path, tmp_path: Path):
    link = workspace / "escape"
    try:
        link.symlink_to(tmp_path, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:  # pragma: no cover - platform
        pytest.skip(f"cannot create a symlink here: {exc}")

    with pytest.raises(PathRejected):
        resolve_within(workspace, "escape/secret.txt")


@pytest.mark.skipif(not WINDOWS, reason="junctions are a Windows reparse point")
def test_a_junction_pointing_out_is_refused(workspace: Path, tmp_path: Path):
    # `mklink /J` needs no privileges, which is exactly why code that only
    # considers symlinks lets this through.
    link = workspace / "junction"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:  # pragma: no cover - platform
        pytest.skip(f"could not create a junction: {result.stderr.strip()}")

    with pytest.raises(PathRejected):
        resolve_within(workspace, "junction/secret.txt")


def _short_name(path: Path) -> str | None:  # pragma: no cover - platform
    """The 8.3 form of a path, if this volume still generates them."""
    buffer = ctypes.create_unicode_buffer(1024)
    length = ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, 1024)
    if length == 0 or length > 1024:
        return None
    short = buffer.value
    return short if short != str(path) else None


@pytest.mark.skipif(not WINDOWS, reason="8.3 short names are a Windows thing")
def test_a_short_name_is_resolved_before_it_is_compared(workspace: Path, tmp_path: Path):
    outside = tmp_path / "Program Files Like"
    outside.mkdir()
    (outside / "secret.txt").write_text("x", encoding="utf-8")

    short = _short_name(outside)
    if short is None:
        pytest.skip("this volume does not generate 8.3 names (8dot3name disabled)")

    # The same directory, spelled differently. A comparison made before
    # resolution sees a path that shares no prefix with the workspace and is
    # equally happy to see one that shares too much.
    with pytest.raises(PathRejected):
        resolve_within(workspace, str(Path(short) / "secret.txt"))


@pytest.mark.skipif(not WINDOWS, reason="8.3 short names are a Windows thing")
def test_a_short_name_inside_the_workspace_still_works(tmp_path: Path):
    root = tmp_path / "Long Workspace Name"
    (root / "Some Long Folder").mkdir(parents=True)
    (root / "Some Long Folder" / "file.txt").write_text("ok", encoding="utf-8")

    short = _short_name(root / "Some Long Folder")
    if short is None:
        pytest.skip("this volume does not generate 8.3 names")

    resolved = resolve_within(root, str(Path(short) / "file.txt"))
    assert resolved.read_text(encoding="utf-8") == "ok"


@pytest.mark.skipif(not WINDOWS, reason="drive-relative paths are a Windows thing")
def test_drive_relative_paths_are_refused(workspace: Path):
    # `C:secret.txt` is "secret.txt in the current directory *of drive C:*" —
    # process state, not a location in the workspace. Joined against the root it
    # quietly becomes a different, contained path, which is the kind of silent
    # reinterpretation that turns into a bug later.
    drive = os.path.splitdrive(str(workspace))[0]
    with pytest.raises(PathRejected):
        resolve_within(workspace, f"{drive}secret.txt")

    # And the other-drive form, which is a genuine escape.
    other = "D:" if drive.upper() != "D:" else "E:"
    with pytest.raises(PathRejected):
        resolve_within(workspace, f"{other}secret.txt")


def test_empty_and_null_paths_are_refused(workspace: Path):
    for bad in ["", "   ", "src/\x00etc/passwd"]:
        with pytest.raises(PathRejected):
            resolve_within(workspace, bad)


def test_the_root_itself_is_inside(workspace: Path):
    # `list_dir()` with no argument asks for the workspace itself.
    assert resolve_within(workspace, ".") == canonical(workspace)
