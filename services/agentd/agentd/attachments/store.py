"""Files the user attached to a round (§12 M9.3).

Kept on disk beside the artifacts, not in `mission_events`: that table is
append-only forever (§9.3), and a handful of screenshots inlined as base64
would make the log unbounded and unreadable. The event carries the name, the
size, the type and a digest — enough for a timeline to say what happened —
and this is where the bytes actually live.

Content-addressed by SHA-256. Attaching the same screenshot to three rounds
stores it once, and the digest on the event is the same string that names the
file, so a row and its bytes cannot drift apart.

Two kinds go in, and they reach a model by different routes, because there is
no single route that works. An **image** travels as a picture, which only a
vision model can read. A **text file** has its contents put into the round's
instruction, which is the only way a text model can read anything at all.

Nothing else is accepted. A PDF, a zip or a spreadsheet cannot be sent to
either endpoint as itself, and taking one to be silently ignored would be the
UI saying "attached" about something that never arrived (§1). The message that
refuses says where such a file does belong: the workspace folder, where the
file tools can reach it.

What decides which kind a file is, is the file — a text attachment is *decoded*
rather than believed. Browsers label a .csv `application/vnd.ms-excel` about as
often as `text/csv`, and a renamed binary is labelled whatever its extension
suggests.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from ..core.config import get_settings
from ..db.models import Attachment
from ..db.session import Database

#: Images, which travel to the model as pictures. What the two APIs accept, and
#: nothing else — the file is about to be base64'd into a request to somebody
#: else's endpoint, and "trust the label" is how a surprising thing gets sent.
IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

#: Everything else is accepted only if it is *actually text*, which is checked
#: by decoding it rather than by believing the browser's `type` — a .csv often
#: arrives as `application/vnd.ms-excel`, and a renamed binary arrives as
#: anything at all.
#:
#: A text file does not go to the model as a file. Its contents are put in the
#: round's instruction, because that is the only way a text model can read
#: anything, and saying "attached" while sending nothing would be the UI
#: claiming something untrue (§1).
TEXT_KIND = "text"
IMAGE_KIND = "image"

#: Per image. Both APIs reject larger, and base64 adds a third on top.
MAX_IMAGE_BYTES = 5 * 1024 * 1024

#: Per text file, and a different number for a different reason: this one goes
#: into the prompt. A megabyte of CSV would eat the whole context and then the
#: budget, so the cap is about what a round can carry, not what the API accepts.
MAX_TEXT_BYTES = 256 * 1024

#: Kept for the file on disk when the type is not one we name.
DEFAULT_SUFFIX = ".txt"


def kind_of(mime: str) -> str:
    return IMAGE_KIND if mime in IMAGE_TYPES else TEXT_KIND


def suffix_for(mime: str, name: str) -> str:
    """The extension to store under. The original name's suffix is kept when it
    has one, so a `.csv` on disk is still recognisably a `.csv`."""
    if mime in IMAGE_TYPES:
        return IMAGE_TYPES[mime]
    tail = Path(name).suffix.lower()
    # Bounded and conservative: an extension is only a filename fragment, and
    # this one is about to become part of a path.
    if 1 < len(tail) <= 10 and tail[1:].isalnum():
        return tail
    return DEFAULT_SUFFIX


class AttachmentRejected(ValueError):
    pass


def root() -> Path:
    return get_settings().data_dir / "attachments"


class AttachmentStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def add(
        self, *, mission_id: str, name: str, mime: str, data: bytes
    ) -> Attachment:
        if not data:
            raise AttachmentRejected("the file is empty")

        kind = kind_of(mime)
        if kind == IMAGE_KIND:
            if len(data) > MAX_IMAGE_BYTES:
                raise AttachmentRejected(
                    f"the image is {len(data):,} bytes; the limit is "
                    f"{MAX_IMAGE_BYTES:,}"
                )
        else:
            # Decoded, not believed. A .csv often arrives labelled
            # `application/vnd.ms-excel`, and a renamed binary arrives labelled
            # anything at all — so what decides is whether it *is* text.
            if len(data) > MAX_TEXT_BYTES:
                raise AttachmentRejected(
                    f"{name} is {len(data):,} bytes; a text attachment goes into "
                    f"the prompt, so the limit is {MAX_TEXT_BYTES:,}. Put larger "
                    "files in the workspace folder and let the tools read them."
                )
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                raise AttachmentRejected(
                    f"{name} is not an image and is not text this app can read. "
                    "Images (PNG, JPEG, WebP, GIF) go to the model as pictures "
                    "and text files go in as text; anything else belongs in the "
                    "workspace folder, where the file tools can reach it."
                ) from None

        digest = hashlib.sha256(data).hexdigest()
        folder = root()
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{digest}{suffix_for(mime, name)}"
        # Content-addressed, so writing the same picture twice is a no-op
        # rather than a second copy.
        if not path.exists():
            path.write_bytes(data)

        async with self._db.session() as session:
            existing = (
                await session.execute(
                    select(Attachment).where(
                        Attachment.mission_id == mission_id,
                        Attachment.sha256 == digest,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                return existing
            row = Attachment(
                id=f"att-{digest[:24]}",
                mission_id=mission_id,
                name=name[:200] or "attachment",
                mime=mime,
                bytes=len(data),
                sha256=digest,
                created_at=datetime.now(UTC),
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return row

    async def for_mission(self, mission_id: str) -> list[Attachment]:
        async with self._db.session() as session:
            rows = await session.execute(
                select(Attachment)
                .where(Attachment.mission_id == mission_id)
                .order_by(Attachment.created_at)
            )
            return list(rows.scalars().all())

    def read(self, row: Attachment) -> bytes:
        path = root() / f"{row.sha256}{suffix_for(row.mime, row.name)}"
        if not path.is_file():
            # The row outliving its bytes is possible — someone cleared the
            # folder — and saying so beats returning an empty file.
            raise AttachmentRejected("the stored file is gone")
        return path.read_bytes()

    def as_base64(self, row: Attachment) -> str:
        return base64.b64encode(self.read(row)).decode("ascii")

    def as_text(self, row: Attachment) -> str:
        """The file's text, for one that is going into a prompt.

        Errors are replaced rather than raised: the file decoded cleanly when
        it was accepted, and a byte that has gone strange since is not a reason
        to lose the whole round.
        """
        return self.read(row).decode("utf-8", errors="replace")
