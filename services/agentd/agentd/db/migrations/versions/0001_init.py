"""initial schema: missions, mission_events, provider_profiles

`missions` already carries `kind`, `roster_snapshot` and `end_reason` even
though M1 barely uses them. By the time M4/M6 need them the table holds real
rows, and adding them then is a data migration rather than a schema edit
(PROJECT_BRIEF.md §5.1).

Revision ID: 0001_init
Revises:
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_init"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "missions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("team_id", sa.String(), nullable=True),
        sa.Column("goal", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(), nullable=False, server_default="running"),
        sa.Column("budget", sa.JSON(), nullable=False),
        sa.Column("roster_snapshot", sa.JSON(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_reason", sa.String(), nullable=True),
        sa.Column("result_summary", sa.Text(), nullable=True),
        sa.CheckConstraint("kind IN ('chat', 'mission')", name="ck_missions_kind"),
    )
    op.create_index("ix_missions_started_at", "missions", ["started_at"])

    op.create_table(
        "mission_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("mission_id", sa.String(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("v", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        # RESTRICT, not CASCADE: this table is append-only forever, and deleting
        # a mission must never quietly erase the record of what happened.
        sa.ForeignKeyConstraint(
            ["mission_id"], ["missions.id"], ondelete="RESTRICT"
        ),
        # The backstop for the single-writer rule (§2.3).
        sa.UniqueConstraint("mission_id", "seq", name="uq_mission_events_seq"),
    )
    op.create_index(
        "ix_mission_events_resume", "mission_events", ["mission_id", "seq"]
    )

    op.create_table(
        "provider_profiles",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("base_url", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=False),
        # Observed capabilities, not advertised ones (§3.1). Null until the
        # user has actually run test connection against this endpoint.
        sa.Column("capabilities", sa.JSON(), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "kind IN ('openai_compatible', 'anthropic')", name="ck_provider_kind"
        ),
    )


def downgrade() -> None:
    op.drop_table("provider_profiles")
    op.drop_index("ix_mission_events_resume", table_name="mission_events")
    op.drop_table("mission_events")
    op.drop_index("ix_missions_started_at", table_name="missions")
    op.drop_table("missions")
