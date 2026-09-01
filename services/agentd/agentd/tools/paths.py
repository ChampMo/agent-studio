"""The one function that decides whether a path is inside the workspace.

Every file tool goes through `resolve_within` (PROJECT_BRIEF.md §16.3). One
resolver, because a second one is a second set of edge cases and only one of
them will get the Windows tests.

What it has to survive, and why each is its own trap:

* **`..`** — the obvious one, and the only one people remember.
* **An absolute path.** `Path(root) / "/etc/passwd"` is `/etc/passwd`: joining
  an absolute path throws the root away. Nothing here rejects absolute paths
  outright — a grep result is an absolute path inside the workspace — so the
  containment check has to be what catches it.
* **Symlinks and, separately, Windows junctions.** A junction is not a symlink;
  it is a different reparse point, `mklink /J` needs no privileges, and code
  that only thinks about symlinks lets it through.
* **8.3 short names.** `C:\\PROGRA~1` and `C:\\Program Files` are the same
  directory spelled two ways, so any comparison made before resolution can be
  fooled by spelling.

The rule that follows from all four: **resolve first, compare second, never the
other way round.** `os.path.realpath` on Windows asks the filesystem
(`GetFinalPathNameByHandle`), which collapses junctions, symlinks and short
names in one step; on POSIX it resolves symlinks. What it cannot do is resolve a
path that does not exist yet — `write_file` creates new files — so the existing
prefix is resolved by the OS and the missing tail is normalised lexically, which
is safe precisely because a path that does not exist cannot be a link.
"""

from __future__ import annotations

import os
from pathlib import Path


class PathRejected(ValueError):
    """A path that would leave the workspace, or cannot be used at all.

    Carries the path as given rather than the resolved one: the resolved form
    of an escape attempt names a real location outside the workspace, and
    putting that in an error message hands back the very information the check
    exists to withhold.
    """

    def __init__(self, given: str, reason: str) -> None:
        super().__init__(f"{reason}: {given!r}")
        self.given = given
        self.reason = reason


def _norm(path: Path | str) -> str:
    """Case-folded on Windows, untouched elsewhere. Comparison only."""
    return os.path.normcase(str(path))


def canonical(path: Path | str) -> Path:
    """Fully resolve an existing path: links, junctions and short names."""
    return Path(os.path.realpath(str(path)))


def canonical_lenient(path: Path | str) -> Path:
    """Resolve as much as exists, then normalise the rest.

    The tail of a path to a file that has not been created yet cannot contain a
    link — there is nothing there to be one — so normalising it lexically is
    sound. Resolving the existing prefix through the OS first is what makes that
    true; doing it the other way round would collapse `link/..` to the link's
    parent instead of its target's.
    """
    raw = Path(os.path.abspath(str(path)))
    missing: list[str] = []
    current = raw
    while not os.path.lexists(current) and current.parent != current:
        missing.append(current.name)
        current = current.parent

    resolved = os.path.realpath(str(current))
    if missing:
        resolved = os.path.normpath(os.path.join(resolved, *reversed(missing)))
    return Path(resolved)


def is_within(root: Path, target: Path) -> bool:
    """Whether `target` is `root` or sits under it.

    Compared on path components rather than string prefixes: `/data/workspace2`
    starts with `/data/workspace` and is a different directory.
    """
    root_parts = Path(_norm(root)).parts
    target_parts = Path(_norm(target)).parts
    return target_parts[: len(root_parts)] == root_parts


def resolve_within(root: Path | str, candidate: str) -> Path:
    """Resolve `candidate` against the workspace, or refuse.

    Returns the fully resolved path, which is what callers must use — resolving
    once here and then opening the string the model sent would reintroduce
    every case above.
    """
    if not candidate or not candidate.strip():
        raise PathRejected(candidate, "empty path")
    if "\x00" in candidate:
        # Truncates in some C APIs, so the path that gets checked and the path
        # that gets opened stop being the same one.
        raise PathRejected(candidate, "path contains a null byte")

    base = canonical(root)
    if not base.is_dir():
        raise PathRejected(str(root), "workspace root is not a directory")

    given = Path(candidate)
    if os.path.splitdrive(candidate)[0] and not given.is_absolute():
        # `C:notes.txt` means "notes.txt in the current directory *of drive C:*",
        # which depends on process state that has nothing to do with the
        # workspace. Joining it against the root quietly turns it into something
        # else that happens to be safe; refusing says what actually happened.
        raise PathRejected(candidate, "drive-relative path")

    joined = given if given.is_absolute() else base / given
    resolved = canonical_lenient(joined)

    if not is_within(base, resolved):
        raise PathRejected(candidate, "path is outside the workspace")
    return resolved
