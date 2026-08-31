"""teams and team_members

Two constraints here carry design weight:

* `UNIQUE(team_id, seat_index)` — stops two characters being drawn at the same
  desk when the scene lands in M5 (PROJECT_BRIEF.md §5).
* a **partial** unique index on the leader row — enforces *at most* one leader.
  SQL cannot express "at least one", so that half is the validator's (§5.2).
  Both halves need to exist or the pair only half works.

`agents.source_id` is added here rather than in 0002 because import is what
needs it, and import arrives with teams (§5.3).

Revision ID: 0003_teams
Revises: 0002_agents
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_teams"
down_revision: str | None = "0002_agents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "teams",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("emblem_config", sa.JSON(), nullable=False),
        sa.Column("scene_layout_id", sa.String(), nullable=False),
        sa.Column("default_budget", sa.JSON(), nullable=False),
        sa.Column("source_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_teams_archived_at", "teams", ["archived_at"])

    op.create_table(
        "team_members",
        sa.Column("team_id", sa.String(), primary_key=True),
        sa.Column("agent_id", sa.String(), primary_key=True),
        sa.Column("seat_index", sa.Integer(), nullable=False),
        sa.Column("role_in_team", sa.String(), nullable=False, server_default="member"),
        sa.Column("overrides", sa.JSON(), nullable=True),
        # CASCADE from the team: removing a team should take its seating with it.
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        # RESTRICT from the agent: an agent on a team is never hard-deleted, it
        # is archived (§5.2), and this makes that a rule rather than a habit.
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("team_id", "seat_index", name="uq_team_members_seat"),
        sa.CheckConstraint(
            "role_in_team IN ('leader', 'member')", name="ck_team_members_role"
        ),
        sa.CheckConstraint("seat_index >= 0", name="ck_team_members_seat_non_negative"),
    )

    # At most one leader per team. Partial indexes are a SQLite feature since
    # 3.8; `sqlite_where` is how Alembic expresses one.
    op.create_index(
        "uq_team_members_one_leader",
        "team_members",
        ["team_id"],
        unique=True,
        sqlite_where=sa.text("role_in_team = 'leader'"),
    )

    with op.batch_alter_table("agents") as batch:
        batch.add_column(sa.Column("source_id", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("agents") as batch:
        batch.drop_column("source_id")
    op.drop_index("uq_team_members_one_leader", table_name="team_members")
    op.drop_table("team_members")
    op.drop_index("ix_teams_archived_at", table_name="teams")
    op.drop_table("teams")
