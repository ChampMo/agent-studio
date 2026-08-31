"""drop agents.exp

Gamification rolled back (PROJECT_BRIEF.md §1.1, §15 row 28). `exp` was a score
we invented: it said nothing true about an agent, and showing it made the UI
lie, which §1 already forbids.

`total_missions` stays — it counts missions that actually finished, so it is a
fact — and so does usage tracking, which is real money the user needs to see.

A new revision rather than an edit to 0002: that migration has already run on
this machine and on any other, and rewriting applied history means two databases
claiming the same revision with different schemas.

Revision ID: 0004_drop_exp
Revises: 0003_teams
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_drop_exp"
down_revision: str | None = "0003_teams"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Batch mode rebuilds the table, and it rebuilds it from what it reflects —
    # including `ck_agents_exp_non_negative`, which would then be recreated
    # against a table that no longer has the column. The constraint has to go
    # in the same batch, before the column it refers to.
    with op.batch_alter_table("agents") as batch:
        batch.drop_constraint("ck_agents_exp_non_negative", type_="check")
        batch.drop_column("exp")


def downgrade() -> None:
    with op.batch_alter_table("agents") as batch:
        batch.add_column(
            sa.Column("exp", sa.Integer(), nullable=False, server_default="0")
        )
        batch.create_check_constraint("ck_agents_exp_non_negative", "exp >= 0")
