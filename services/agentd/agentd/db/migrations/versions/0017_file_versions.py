"""What a file looked like after each change.

The Files tab can say who changed what and when from the log alone. What it
cannot say is *what changed*, because `write_file.content` and `edit_file`'s
strings are declared in `redact_fields` and replaced by a byte count before the
event is built — `mission_events` is append-only for ever, and a run that
writes a 20KB file eleven times would put 220KB of source into a table nobody
can prune.

So the bytes go where the attachments' bytes go: on disk, content-addressed by
SHA-256, with only the digest here. Writing the same content twice stores it
once.

Nothing is backfilled and nothing can be: the content of every write before
this table existed was never kept anywhere. Those runs keep the history they
have — who, when, and how many bytes — which was true of them.

Revision ID: 0017_file_versions
Revises: 0016_end_limit_and_artifact_source
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_file_versions"
down_revision: str | None = "0016_end_limit_and_artifact_source"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "file_versions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("mission_id", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("bytes", sa.Integer(), nullable=False),
        sa.Column("lines", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("agent_id", sa.String(), nullable=True),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_file_versions_file", "file_versions", ["mission_id", "path"])


def downgrade() -> None:
    op.drop_index("ix_file_versions_file", table_name="file_versions")
    op.drop_table("file_versions")
