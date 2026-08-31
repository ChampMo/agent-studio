"""artifacts, and a mission status for waiting on a human

Two changes, both needed by M6 (PROJECT_BRIEF.md §12 M6).

`artifacts` finally exists — the table was specified in §5 and the
`artifact.created` event has been in the schema since M1 without ever firing.

`missions.status` gains `waiting`. This one matters: `reap_orphans()` closes
every mission left `running` by a dead process, and a mission paused on a human
answer has no running task *by design*. Without a status that tells them apart,
restarting the backend would destroy exactly the missions the milestone promises
survive a restart.

Revision ID: 0005_hitl_artifacts
Revises: 0004_drop_exp
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_hitl_artifacts"
down_revision: str | None = "0004_drop_exp"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "artifacts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("mission_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        # Relative to the artifact root, never an absolute host path: the viewer
        # must not be able to open anything outside it (§2.7).
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["mission_id"], ["missions.id"], ondelete="RESTRICT"),
        sa.CheckConstraint("kind IN ('code', 'doc', 'image')", name="ck_artifacts_kind"),
        sa.UniqueConstraint("mission_id", "path", name="uq_artifacts_path"),
    )
    op.create_index("ix_artifacts_mission", "artifacts", ["mission_id"])

    # `pending_request` holds the id of the question the mission is blocked on,
    # so the answer can be routed without replaying the event log to find it.
    with op.batch_alter_table("missions") as batch:
        batch.add_column(sa.Column("pending_request", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("missions") as batch:
        batch.drop_column("pending_request")
    op.drop_index("ix_artifacts_mission", table_name="artifacts")
    op.drop_table("artifacts")
