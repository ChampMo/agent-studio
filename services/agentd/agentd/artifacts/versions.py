"""What a file looked like after each change (§9.3, §12 M6).

The Files tab can say *who changed what and when* off the log alone, because
every write leaves an `agent.tool.start` naming the path and an
`agent.tool.end` carrying its size. What it cannot say is **what changed**, and
that is a deliberate hole rather than an oversight: `write_file.content` and
`edit_file.old_str` / `new_str` are declared in `redact_fields` and replaced
with a byte count before the event is built, because `mission_events` is
append-only for ever and a run that writes a 20KB file eleven times would put
220KB of source into a table nobody can prune.

So the bytes go where the attachments' bytes go: **on disk, content-addressed
by SHA-256**, with only the digest in the database. Writing the same content
twice — a rewrite that changed nothing, or the same boilerplate in two files —
stores it once, and the digest that names the row is the string that names the
file, so a row and its bytes cannot drift apart.

Two things this is honest about.

**It keeps copies of the user's files.** That is new, and it is the price of
being able to show a diff at all; the alternative is a Files tab that can only
say "2,898 bytes" about a change. They live under the app's own data folder,
which Settings names and can open.

**A version is what the file held when the write finished** — read back from
the workspace, not reconstructed from the tool's arguments. If someone edits
the file in an editor between two agent writes, that edit shows up inside the
next diff, attributed to nobody, which is exactly what happened.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from ..core.config import get_settings
from ..db.models import FileVersion
from ..db.session import Database
from ..tools.paths import PathRejected, canonical, resolve_within

#: Past this a file is not something the viewer can usefully diff, and keeping
#: a copy of it on every write is a real cost for no gain. The version is
#: skipped and the change still appears in the history with its size.
MAX_BYTES = 1024 * 1024


def root() -> Path:
    return get_settings().data_dir / "file-versions"


class VersionStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def record(
        self,
        *,
        mission_id: str,
        path: str,
        workspace_root: str,
        agent_id: str | None,
        event_id: str,
    ) -> FileVersion | None:
        """Keep what the file holds now, or nothing if it cannot be kept.

        Returns None rather than raising: a version is a convenience on top of
        a change that already happened, and failing to store one must never
        turn a successful write into an error on the timeline.
        """
        try:
            target = resolve_within(canonical(workspace_root), path)
            data = target.read_bytes()
        except (OSError, PathRejected):
            return None
        if len(data) > MAX_BYTES:
            return None

        # Decoded, not assumed. A binary that an agent happened to write is not
        # something to diff, and storing it would be storing bytes the viewer
        # can only refuse.
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return None

        digest = hashlib.sha256(data).hexdigest()
        blob = root() / digest
        if not blob.exists():
            blob.parent.mkdir(parents=True, exist_ok=True)
            # Written as bytes: the digest is of the bytes, and re-encoding
            # would be a second chance to disagree with it.
            blob.write_bytes(data)

        row = FileVersion(
            id=f"ver-{uuid.uuid4()}",
            mission_id=mission_id,
            path=path,
            sha256=digest,
            bytes=len(data),
            lines=text.count("\n") + (0 if text.endswith("\n") or not text else 1),
            agent_id=agent_id,
            event_id=event_id,
            created_at=datetime.now(UTC),
        )
        async with self._db.session() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
        return row

    async def for_file(self, mission_id: str, path: str) -> list[FileVersion]:
        """Every version of one file, oldest first — which is the order a diff
        walks: each one against the one before it."""
        async with self._db.session() as session:
            rows = await session.execute(
                select(FileVersion)
                .where(FileVersion.mission_id == mission_id)
                .where(FileVersion.path == path)
                .order_by(FileVersion.created_at, FileVersion.id)
            )
            return list(rows.scalars().all())

    async def get(self, version_id: str) -> FileVersion | None:
        async with self._db.session() as session:
            return (
                await session.execute(
                    select(FileVersion).where(FileVersion.id == version_id)
                )
            ).scalar_one_or_none()

    def read_text(self, row: FileVersion) -> str:
        blob = root() / row.sha256
        if not blob.is_file():
            # The row outlives the blob if the data folder was cleaned. Said
            # plainly rather than crashing the viewer.
            raise FileNotFoundError("the stored copy of this version is missing")
        return blob.read_text(encoding="utf-8", errors="replace")


def to_json(row: FileVersion) -> dict[str, object]:
    return {
        "id": row.id,
        "missionId": row.mission_id,
        "path": row.path,
        "sha256": row.sha256,
        "bytes": row.bytes,
        "lines": row.lines,
        "agentId": row.agent_id,
        "eventId": row.event_id,
        "createdAt": row.created_at.isoformat(),
    }
