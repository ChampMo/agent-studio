"""Images the user attached to a round (§12 M9.3)

Metadata only. The bytes live on disk under `attachments/<sha256>.<ext>`,
content-addressed, for the same reason artifacts do: `mission_events` is
append-only forever, and a screenshot inlined as base64 would make the log
unbounded and unreadable (§9.3).

The event carries the digest and this row carries the digest, so a record and
its bytes cannot drift apart — and attaching the same picture to three rounds
stores it once.

Revision ID: 0013_attachments
Revises: 0012_app_settings
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_attachments"
down_revision: str | None = "0012_app_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "attachments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("mission_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("mime", sa.String(), nullable=False),
        sa.Column("bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("mission_id", "sha256", name="uq_attachment_per_mission"),
    )
    op.create_index("ix_attachments_mission", "attachments", ["mission_id"])


def downgrade() -> None:
    op.drop_index("ix_attachments_mission", table_name="attachments")
    op.drop_table("attachments")
