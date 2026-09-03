"""Give a mission a name of its own (§18.2)

Until now one column did two jobs: `goal` was both what the team was told to do
and what every list showed as the run's name. That works while a run is one
instruction, and stops working the moment the run is a conversation — the first
thing typed becomes the instruction, and it is a sentence, not a name. The
history list was showing whole paragraphs as titles.

So `title` is what a person calls the run and `goal` stays what the team was
asked to do. Nullable, because every run recorded before this migration has no
title and inventing one for them would be writing fiction into the record —
the UI falls back to the goal for those, which is what they were named at the
time.

Revision ID: 0010_mission_title
Revises: 0009_search_kind
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010_mission_title"
down_revision: str | None = "0009_search_kind"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("missions", sa.Column("title", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("missions", "title")
