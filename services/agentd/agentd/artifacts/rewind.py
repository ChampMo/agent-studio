"""Put the workspace back the way it was at a point in the run.

The app already had every piece of this and no way to use them. `file_versions`
keeps what each file held after each write, content-addressed; the Files tab
shows the diffs; the log is append-only so "that moment" is addressable by the
event that made it. What was missing was the one operation anybody actually
wants when a round goes wrong: **undo it**.

Three things it is careful about, and each is a claim it must not overstate.

**It only knows what the file tools wrote.** `FILE_TOOLS = ("write_file",
"edit_file")` is what the runner records, so a file created or moved by `bash`
has no version and cannot be restored. That is not a footnote: the case in
this project's own notes — an agent that ran `mv components /tmp/components.bak`
to bisect a build and was cut off mid-bisect — is precisely the case this
**cannot** fix. So `plan()` reports what it will do before anything happens,
and the caller shows it.

**Restoring is itself a change**, so the file as it stands now is recorded as a
version first. A rewind is therefore undoable by rewinding again, and the Files
tab shows it as what it is: another entry in the history, attributed to nobody,
because no agent wrote it.

**It never leaves the workspace.** Every path goes through `resolve_within`
against the mission's own root, resolve-first-compare-second, the same rule the
file tools follow. A stored path is data, and data that chooses which file to
open has to be checked — this process holds the user's keychain.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from ..db.models import FileVersion, MissionEvent
from ..db.session import Database
from ..tools.paths import PathRejected, canonical, resolve_within
from .versions import VersionStore, root as versions_root

log = logging.getLogger("agentd.rewind")


@dataclass(frozen=True)
class Restore:
    """One file, and what would happen to it."""

    path: str
    #: The version to write back, or None when there is nothing to write back
    #: to — the file was first written *after* the chosen point, so at that
    #: point it did not exist.
    version_id: str | None
    #: What this build can honestly do about it.
    #:   "restore"  — a stored version exists and differs from what is there
    #:   "unchanged"— the file already holds exactly that
    #:   "created_after" — it did not exist at that point; we do not delete it
    #:   "missing_blob"  — the row outlived its bytes
    action: str
    bytes: int | None = None

    def to_json(self) -> dict[str, object]:
        return {
            "path": self.path,
            "versionId": self.version_id,
            "action": self.action,
            "bytes": self.bytes,
        }


@dataclass(frozen=True)
class Plan:
    """What a rewind would do, before it does any of it."""

    seq: int
    restores: list[Restore]

    @property
    def changes(self) -> list[Restore]:
        return [r for r in self.restores if r.action == "restore"]

    def to_json(self) -> dict[str, object]:
        return {
            "seq": self.seq,
            "files": [r.to_json() for r in self.restores],
            "willChange": len(self.changes),
        }


class Rewinder:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._versions = VersionStore(db)

    async def plan(self, *, mission_id: str, seq: int) -> Plan:
        """What the workspace held at `seq`, as far as this app recorded it.

        For each file the run touched, the newest version at or before that
        point. A file with no version that early was created afterwards, and is
        reported rather than deleted — deleting something we have no copy of is
        not an undo, it is a second kind of loss.
        """
        cutoff = await self._time_of(mission_id, seq)

        async with self._db.session() as session:
            rows = list(
                (
                    await session.execute(
                        select(FileVersion)
                        .where(FileVersion.mission_id == mission_id)
                        .order_by(FileVersion.created_at, FileVersion.id)
                    )
                )
                .scalars()
                .all()
            )

        newest: dict[str, FileVersion] = {}
        # Every path the run touched, each once. Tracked separately from
        # `newest`, which only holds paths that *have* a version early enough —
        # keying "have I seen this path" off that dictionary listed a file once
        # per version whenever all of its versions came after the cutoff, so a
        # run that wrote one file three times offered it three times.
        seen: set[str] = set()
        for row in rows:
            seen.add(row.path)
            if cutoff is not None and _epoch(row.created_at) > cutoff:
                continue
            newest[row.path] = row

        return Plan(
            seq=seq,
            restores=[
                self._describe(path, newest.get(path)) for path in sorted(seen)
            ],
        )

    def _describe(self, path: str, row: FileVersion | None) -> Restore:
        if row is None:
            return Restore(path=path, version_id=None, action="created_after")
        if not (versions_root() / row.sha256).is_file():
            return Restore(path=path, version_id=row.id, action="missing_blob")
        return Restore(
            path=path, version_id=row.id, action="restore", bytes=row.bytes
        )

    async def apply(
        self, *, mission_id: str, seq: int, workspace_root: str
    ) -> dict[str, object]:
        """Write the plan back to disk.

        Each file's current contents are recorded as a version *first*, so this
        is undoable by rewinding again — and so the Files tab shows the rewind
        as an entry in the history rather than as a file that silently changed
        under it.
        """
        plan = await self.plan(mission_id=mission_id, seq=seq)
        root = canonical(workspace_root)
        restored: list[str] = []
        skipped: list[dict[str, object]] = []

        for item in plan.restores:
            if item.action != "restore" or item.version_id is None:
                skipped.append(item.to_json())
                continue
            row = await self._versions.get(item.version_id)
            if row is None:
                skipped.append({**item.to_json(), "action": "missing_row"})
                continue
            try:
                target = resolve_within(root, item.path)
                text = self._versions.read_text(row)
            except (PathRejected, FileNotFoundError, OSError) as exc:
                # A path that no longer resolves inside this workspace, or a
                # blob that is gone. Reported per file: one unrestorable file
                # must not abandon the rest half-done.
                skipped.append({**item.to_json(), "action": "failed", "why": str(exc)})
                continue

            if target.is_file() and target.read_text(encoding="utf-8", errors="replace") == text:
                skipped.append({**item.to_json(), "action": "unchanged"})
                continue

            # Keep what is there now before overwriting it. Recorded with no
            # agent, because no agent wrote it.
            if target.is_file():
                await self._versions.record(
                    mission_id=mission_id,
                    path=item.path,
                    workspace_root=workspace_root,
                    agent_id=None,
                    event_id=f"rewind-before-{seq}",
                )

            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="")
            restored.append(item.path)

            # And the state it is in now, so the history's last entry is the
            # file as it actually stands.
            await self._versions.record(
                mission_id=mission_id,
                path=item.path,
                workspace_root=workspace_root,
                agent_id=None,
                event_id=f"rewind-{seq}",
            )

        return {"seq": seq, "restored": restored, "skipped": skipped}

    async def _time_of(self, mission_id: str, seq: int) -> float | None:
        """When the chosen event happened.

        Versions are stamped with a wall clock and events with a sequence, so
        the two are matched through the event's own timestamp. Both are written
        by this process, in order, which is what makes that sound.
        """
        async with self._db.session() as session:
            row = (
                await session.execute(
                    select(MissionEvent)
                    .where(MissionEvent.mission_id == mission_id)
                    .where(MissionEvent.seq == seq)
                )
            ).scalar_one_or_none()
        if row is None:
            return None
        return _epoch(row.ts)


def _epoch(stamp: datetime) -> float:
    """Seconds since the epoch, reading a stored timestamp as UTC.

    `DateTime(timezone=True)` is a no-op on SQLite, so both the event and the
    version come back **naive** — and `datetime.timestamp()` reads a naive value
    as *local* time. On this machine that is UTC+7, so the comparison was seven
    hours out and a rewind restored files it should have left alone.

    Written down because this is the third time: `_wire` hit it for event
    timestamps in M1, `as_utc_iso` hit it for mission timestamps in M10, and
    both times the symptom was a number that looked plausible and was wrong by
    exactly the machine's offset.
    """
    return (stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)).timestamp()
