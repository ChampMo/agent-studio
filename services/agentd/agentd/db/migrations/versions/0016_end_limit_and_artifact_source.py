"""Which ceiling ended a run, and where an artifact's file actually is.

**`missions.end_limit`.** `budget_exceeded` covers tokens, model calls, graph
steps and wall-clock time — four problems whose fixes have nothing to do with
each other — and every list rendered them as one phrase, "Out of budget". Three
runs in a row that were stopped by the *clock* were read as having run out of
tokens, including by the person writing them up. The real reason was in the
ending's summary prose the whole time; nothing could read it but a person.

Nullable, and **not backfilled**. A run recorded before this column has no
honest value to put here: the summary of an old row might be parseable, and a
guess written into a column reads as a recorded fact forever (§5.1, §6.2). Those
rows keep the general phrase, which was true of them.

**`artifacts.source`.** An artifact used to mean one thing: a file the app wrote
under its own artifact root. So `artifact.created` was published from exactly one
place in the codebase — `final-answer.md`, on a run that completed — and every
file an agent actually produced was invisible to the app. The Files tab read
"Files 0" over a workspace holding twenty files and a Next.js app that built.

A workspace file is a different kind of thing and says so rather than being
copied in: it lives in the folder the user chose, the agents keep editing it,
and a copy taken at write time would be a stale duplicate claiming to be the
work. `store` is the old meaning and the default, so existing rows keep it.

Revision ID: 0016_end_limit_and_artifact_source
Revises: 0015_search_order
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016_end_limit_and_artifact_source"
down_revision: str | None = "0015_search_order"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("missions", sa.Column("end_limit", sa.String(), nullable=True))
    op.add_column(
        "artifacts",
        sa.Column(
            "source", sa.String(), nullable=False, server_default="store"
        ),
    )


def downgrade() -> None:
    op.drop_column("artifacts", "source")
    op.drop_column("missions", "end_limit")
