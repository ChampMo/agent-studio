"""agents table

No `level` column: it is derived from `exp` and storing both is storing the same
fact twice (PROJECT_BRIEF.md §5, decision row 12).

No `temperature` column either — `sampling` is JSON, because some models reject
sampling parameters outright and the provider decides what to send from observed
capabilities (§3.1).

Revision ID: 0002_agents
Revises: 0001_init
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_agents"
down_revision: str | None = "0001_init"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agents",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False, server_default=""),
        sa.Column("role", sa.String(), nullable=False, server_default=""),
        sa.Column("backstory", sa.Text(), nullable=False, server_default=""),
        sa.Column("personality_traits", sa.JSON(), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=False, server_default=""),
        # SET NULL rather than RESTRICT: deleting a provider profile should not
        # be blocked by an agent, and an agent without a provider is a state the
        # UI can show and the user can fix.
        sa.Column("provider_id", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("sampling", sa.JSON(), nullable=True),
        sa.Column("tools", sa.JSON(), nullable=False),
        sa.Column("avatar_config", sa.JSON(), nullable=False),
        sa.Column("exp", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_missions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["provider_id"], ["provider_profiles.id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint("exp >= 0", name="ck_agents_exp_non_negative"),
    )
    op.create_index("ix_agents_archived_at", "agents", ["archived_at"])


def downgrade() -> None:
    op.drop_index("ix_agents_archived_at", table_name="agents")
    op.drop_table("agents")
