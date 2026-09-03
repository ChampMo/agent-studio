"""Which search key is tried first (§16.5)

The fallback chain was ordered by `created_at` — a proxy for "the order to try
them" that is right only by accident. The two are different things the moment
someone wants the cheaper key spent first, and nothing in the app could say so.

Nullable, and null sorts last. A key added before this column, or added since
and never reordered, keeps falling back on `created_at`, so an install that has
never touched the order behaves exactly as it did. There is no backfill for the
same reason: writing positions into rows nobody has ordered would be recording a
decision that was never made (§5.1).

Revision ID: 0015_search_order
Revises: 0014_search_quota
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015_search_order"
down_revision: str | None = "0014_search_quota"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "provider_profiles", sa.Column("sort_order", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("provider_profiles", "sort_order")
