"""Remove `model_prices` — a feature that was built and withdrawn the same day

The table held rates the user could type in for models `pricing.json` does not
carry, so that Cost stopped reading "Not priced" on every DeepSeek run. It
worked. It was also the wrong answer: a figure you have to look up on your
provider's billing page and copy into an app is a chore in exchange for a number
you were already looking at, and the app then has a second place for it to go
stale. The Cost row is gone instead.

This revision keeps its original id because a database was already stamped with
it. `upgrade` drops the table when it is there and does nothing when it is not,
so a machine that ran the old 0011 and a fresh install both end up in the same
state — which is the property that matters about a migration chain.

Revision ID: 0011_model_prices
Revises: 0010_mission_title
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011_model_prices"
down_revision: str | None = "0010_mission_title"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("model_prices"):
        op.drop_table("model_prices")


def downgrade() -> None:
    """Nothing to put back. The table carried settings, not history — no run's
    record depended on it, and recreating an empty one would restore only the
    shape of a feature that no longer exists."""
