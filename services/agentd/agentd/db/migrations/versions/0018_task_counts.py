"""How much of the plan a run got through.

The sidebar lists every past run and could say nothing about what any of them
managed. The header can — "10 of 12 tasks done" — but only for the run that is
open, because it counts `mission.progress` off that run's own log. A list of
seventeen rows cannot read seventeen logs.

So the two numbers live on the row, written as the tasks change. Nullable and
**not backfilled**: a run recorded before this column has no honest value to
put there, and the count could only be recovered by reading its whole log,
which is exactly the thing this column exists to avoid. Those rows show no
counts, which is true of them (§5.1).

`tasks_total` is the plan's own length, so a run whose planning failed keeps
null rather than 0 — "0 of 0 done" would read as a run that finished nothing
when in fact it never had anything to finish.

Revision ID: 0018_task_counts
Revises: 0017_file_versions
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018_task_counts"
down_revision: str | None = "0017_file_versions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("missions", sa.Column("tasks_done", sa.Integer(), nullable=True))
    op.add_column("missions", sa.Column("tasks_total", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("missions", "tasks_total")
    op.drop_column("missions", "tasks_done")
