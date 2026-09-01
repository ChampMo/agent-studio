"""Choosing, checking and remembering the folder a mission may touch (§16.2).

The path arrives from the frontend, so it is untrusted input in the ordinary
sense: the window can be driven by a page, and a mission with a workspace of
`C:\\` is a mission whose file tools reach everything. The checks therefore live
here, on the backend, and the same function runs for a path typed by hand and
one chosen from the recent list — "it passed once" is not a permission.

Two severities, and the difference is deliberate:

* **Rejected** — a system directory, or something that is not a directory at
  all. There is no legitimate reason to point an agent at `C:\\Windows`, and the
  cost of being wrong is unbounded.
* **Warned** — home, Desktop, Documents, a drive root. These are real choices
  people occasionally mean, and refusing them would be this file deciding what
  the user is allowed to work on. What they are not is what someone meant by
  "my project folder", so they are said out loud and allowed.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select

from ..db.models import RecentWorkspace
from ..db.session import Database
from .paths import canonical

#: How many folders the picker offers. Ten is enough to cover the projects
#: someone moves between and short enough to still be a list rather than a log.
RECENT_LIMIT = 10


class WorkspaceRejected(ValueError):
    """This folder cannot be a workspace at all."""

    def __init__(self, path: str, reason: str) -> None:
        super().__init__(reason)
        self.path = path
        self.reason = reason


@dataclass(frozen=True)
class Warning_:
    code: str
    message: str

    def to_json(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class Workspace:
    """A folder that passed, with anything worth saying about it."""

    path: str
    warnings: list[Warning_]

    def to_json(self) -> dict[str, Any]:
        return {"path": self.path, "warnings": [w.to_json() for w in self.warnings]}


def _system_roots() -> list[Path]:
    """Directories no agent should be pointed at, whatever the user clicks."""
    roots: list[Path] = []
    if sys.platform == "win32":
        for variable in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
            value = os.environ.get(variable)
            if value:
                roots.append(Path(value))
        # Named explicitly as well: the variables can be unset or rewritten, and
        # this list is the one that has to hold when they are.
        roots += [Path(r"C:\Windows"), Path(r"C:\Program Files"), Path(r"C:\Program Files (x86)")]
    else:
        roots += [Path(p) for p in ("/etc", "/usr", "/bin", "/sbin", "/lib", "/boot", "/dev", "/proc", "/sys", "/var")]
        if sys.platform == "darwin":
            roots += [Path("/System"), Path("/Library"), Path("/Applications")]
    return roots


def _broad_places() -> list[tuple[Path, str, str]]:
    """Folders that are legitimate but almost never what someone meant."""
    home = Path.home()
    places = [
        (home, "home_directory", "This is your home directory — everything you own is under it."),
        (home / "Desktop", "desktop", "The Desktop holds unrelated files from everywhere."),
        (home / "Documents", "documents", "Documents holds unrelated files from everywhere."),
        (home / "Downloads", "downloads", "Downloads holds files that arrived from the internet."),
    ]
    return [(p, code, message) for p, code, message in places]


def check(path: str) -> Workspace:
    """Resolve a candidate workspace and decide whether it may be used.

    Resolution comes first, always: a path is compared only after the
    filesystem has said what it really is (§16.3).
    """
    if not path or not path.strip():
        raise WorkspaceRejected(path, "no folder was chosen")

    try:
        resolved = canonical(path)
    except OSError as exc:
        raise WorkspaceRejected(path, f"this path cannot be read: {exc}") from exc

    if not resolved.exists():
        raise WorkspaceRejected(path, "this folder does not exist")
    if not resolved.is_dir():
        raise WorkspaceRejected(path, "this is a file, not a folder")

    normalised = os.path.normcase(str(resolved))
    for system in _system_roots():
        system_norm = os.path.normcase(str(system))
        if normalised == system_norm or normalised.startswith(system_norm + os.sep):
            raise WorkspaceRejected(
                str(resolved), f"{resolved} is part of the operating system"
            )

    warnings: list[Warning_] = []
    if resolved.parent == resolved:
        # A drive root or `/`: every project on the machine, in scope at once.
        warnings.append(
            Warning_(
                "drive_root",
                f"{resolved} is the root of a drive — every folder on it is in scope.",
            )
        )
    for place, code, message in _broad_places():
        try:
            if os.path.normcase(str(canonical(place))) == normalised:
                warnings.append(Warning_(code, message))
        except OSError:
            # A place that does not exist on this machine is not a match.
            continue

    return Workspace(path=str(resolved), warnings=warnings)


class WorkspaceStore:
    """The recent list. A convenience, not a permission (§16.2)."""

    def __init__(self, db: Database) -> None:
        self._db = db

    async def remember(self, path: str) -> None:
        async with self._db.session() as session:
            row = await session.get(RecentWorkspace, path)
            now = datetime.now(UTC)
            if row is None:
                session.add(RecentWorkspace(path=path, last_used_at=now))
            else:
                row.last_used_at = now
            await session.flush()

            # Trim to the newest few, so the list stays something a person can
            # read rather than a history of everywhere they have ever been.
            keep = (
                await session.execute(
                    select(RecentWorkspace.path)
                    .order_by(RecentWorkspace.last_used_at.desc())
                    .limit(RECENT_LIMIT)
                )
            ).scalars().all()
            await session.execute(
                delete(RecentWorkspace).where(RecentWorkspace.path.notin_(list(keep)))
            )
            await session.commit()

    async def recent(self) -> list[dict[str, Any]]:
        async with self._db.session() as session:
            rows = await session.execute(
                select(RecentWorkspace)
                .order_by(RecentWorkspace.last_used_at.desc())
                .limit(RECENT_LIMIT)
            )
            return [
                {
                    "path": row.path,
                    "lastUsedAt": row.last_used_at.isoformat(),
                    # Whether it is still there. A folder that has been moved or
                    # deleted should look different in the picker, not fail when
                    # chosen.
                    "exists": Path(row.path).is_dir(),
                }
                for row in rows.scalars().all()
            ]
