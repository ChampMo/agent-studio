"""Where a mission's work products are kept (PROJECT_BRIEF.md §5, §12 M6).

Every path is relative to one root and resolved through `_safe()`, which
refuses anything that escapes it. A viewer that could be pointed at an absolute
path, or at `../../`, would turn "look at what the agent produced" into "read
any file on this machine" — and the app holds the user's keychain.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from ..core.config import get_settings
from ..tools.paths import PathRejected, canonical, resolve_within
from ..db.models import Artifact
from ..db.session import Database

KINDS = ("code", "doc", "image")

#: A generous cap. An artifact is a work product, not a data dump, and the
#: viewer has to render it.
MAX_BYTES = 2 * 1024 * 1024

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class ArtifactRejected(ValueError):
    pass


def root() -> Path:
    return get_settings().data_dir / "artifacts"


def _safe(mission_id: str, relative: str) -> Path:
    """Resolve a stored path, or refuse it.

    Checked after resolution, not before: `a/../../etc/passwd` only reveals
    itself as an escape once the `..` segments have been collapsed.
    """
    base = (root() / mission_id).resolve()
    target = (base / relative).resolve()
    if base != target and base not in target.parents:
        raise ArtifactRejected(f"{relative!r} resolves outside the artifact root")
    return target


#: Which of the three kinds a workspace file is, by extension. Only what the
#: viewer can actually render differently; everything else is a document,
#: because calling an unknown file "code" would be a guess on the record.
CODE_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
    ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".kt", ".sh",
    ".sql", ".css", ".scss", ".html", ".json", ".yaml", ".yml", ".toml",
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}


def kind_for(relative: str) -> str:
    suffix = Path(relative).suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        return "image"
    if suffix in CODE_SUFFIXES:
        return "code"
    return "doc"


def safe_name(title: str, suffix: str) -> str:
    stem = _UNSAFE.sub("-", title.strip()).strip("-").lower()[:60] or "artifact"
    return f"{stem}{suffix}"


class ArtifactStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def write_text(
        self,
        *,
        mission_id: str,
        agent_id: str | None,
        title: str,
        text: str,
        kind: str = "doc",
        suffix: str = ".md",
    ) -> Artifact:
        if kind not in KINDS:
            raise ArtifactRejected(f"unknown artifact kind {kind!r}")

        data = text.encode("utf-8")
        if len(data) > MAX_BYTES:
            raise ArtifactRejected(
                f"artifact is {len(data)} bytes; the limit is {MAX_BYTES}"
            )

        relative = safe_name(title, suffix)
        # A mission can produce two tasks with the same title; the record has a
        # unique constraint on (mission_id, path) and this keeps the write from
        # colliding with it rather than failing halfway.
        existing = {a.path for a in await self.for_mission(mission_id)}
        if relative in existing:
            stem, dot, ext = relative.rpartition(".")
            n = 2
            while f"{stem}-{n}{dot}{ext}" in existing:
                n += 1
            relative = f"{stem}-{n}{dot}{ext}"

        target = _safe(mission_id, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")

        artifact = Artifact(
            id=f"art-{uuid.uuid4()}",
            mission_id=mission_id,
            agent_id=agent_id,
            kind=kind,
            path=relative,
            title=title[:200],
            bytes=len(data),
            created_at=datetime.now(UTC),
        )
        async with self._db.session() as s:
            s.add(artifact)
            await s.commit()
        return artifact

    async def note_workspace_file(
        self,
        *,
        mission_id: str,
        agent_id: str | None,
        relative: str,
        workspace_root: str,
    ) -> tuple[Artifact, bool]:
        """Record a file an agent wrote into the mission's own workspace.

        Returns the row and whether it is new, because writing the same file
        twice is one file written twice — the timeline should say `created`
        once and then let the size change underneath it.

        **Nothing is copied.** `write_text` puts a file under the app's artifact
        root and owns it from then on; this points at a file in the folder the
        user chose, which the agents keep editing and the user can open in an
        editor. A copy taken at write time would be a stale duplicate claiming
        to be the work, and there would be two answers to "what did this run
        produce" (§2.1).

        The consequence is stated rather than hidden: the row can outlive the
        file. `read_text` says so plainly when it does.
        """
        size = 0
        try:
            size = resolve_within(canonical(workspace_root), relative).stat().st_size
        except (OSError, PathRejected):
            # The size is a convenience. A file that cannot be measured is
            # still worth listing — the alternative is a run whose output does
            # not appear because one `stat` failed.
            pass

        async with self._db.session() as s:
            row = (
                await s.execute(
                    select(Artifact)
                    .where(Artifact.mission_id == mission_id)
                    .where(Artifact.path == relative)
                )
            ).scalar_one_or_none()
            if row is not None:
                row.bytes = size
                await s.commit()
                await s.refresh(row)
                return row, False

            artifact = Artifact(
                id=f"art-{uuid.uuid4()}",
                mission_id=mission_id,
                agent_id=agent_id,
                kind=kind_for(relative),
                path=relative,
                source="workspace",
                title=relative,
                bytes=size,
                created_at=datetime.now(UTC),
            )
            s.add(artifact)
            await s.commit()
            await s.refresh(artifact)
            return artifact, True

    async def for_mission(self, mission_id: str) -> list[Artifact]:
        async with self._db.session() as s:
            rows = await s.execute(
                select(Artifact)
                .where(Artifact.mission_id == mission_id)
                .order_by(Artifact.created_at)
            )
            return list(rows.scalars().all())

    async def get(self, artifact_id: str) -> Artifact | None:
        async with self._db.session() as s:
            return (
                await s.execute(select(Artifact).where(Artifact.id == artifact_id))
            ).scalar_one_or_none()

    async def remove(self, artifact: Artifact) -> None:
        """Delete the file this row points at, if it is still there.

        The row is the caller's to delete; this is only the file. A missing one
        is not an error — the data directory may have been cleaned — and
        refusing to continue would leave a mission half deleted.
        """
        try:
            path = _safe(artifact.mission_id, artifact.path)
        except ArtifactRejected:
            # A stored path that no longer resolves inside the artifact root is
            # not ours to delete, whatever it is.
            return
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # Locked by something else, or on a volume that has gone. The row
            # still goes; a file left behind is tidier than a delete that stops
            # half way.
            return

    async def read_text(self, artifact: Artifact, workspace_root: str | None = None) -> str:
        if artifact.source == "workspace":
            if not workspace_root:
                raise ArtifactRejected(
                    "this file is in the mission's workspace, and the mission "
                    "has no workspace recorded"
                )
            # The same resolver the file tools use, and the same rule: resolve
            # first, compare second. A stored path is data, and data that
            # decides which file to open is data that has to be checked.
            try:
                path = resolve_within(canonical(workspace_root), artifact.path)
            except PathRejected as exc:
                raise ArtifactRejected(str(exc)) from exc
        else:
            path = _safe(artifact.mission_id, artifact.path)
        if not path.is_file():
            # The row outlives the file: the data directory was cleaned, or —
            # for a workspace file — someone moved or deleted it, which is
            # entirely their right. Said plainly rather than crashing the
            # viewer.
            raise ArtifactRejected("the file for this artifact is missing")
        if path.stat().st_size > MAX_BYTES:
            raise ArtifactRejected(
                f"this file is {path.stat().st_size} bytes; the viewer stops at {MAX_BYTES}"
            )
        return path.read_text(encoding="utf-8", errors="replace")


def to_json(artifact: Artifact) -> dict[str, Any]:
    return {
        "source": artifact.source,
        "id": artifact.id,
        "missionId": artifact.mission_id,
        "agentId": artifact.agent_id,
        "kind": artifact.kind,
        "path": artifact.path,
        "title": artifact.title,
        "bytes": artifact.bytes,
        "createdAt": artifact.created_at.isoformat(),
    }
