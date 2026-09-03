"""What a search endpoint said about its own allowance (§16.5)

Brave sends `x-ratelimit-policy`, `-limit`, `-remaining` and `-reset` with every
answer. Tavily sends nothing. That difference is the whole design, and it needs
three states rather than two:

* **null** — never measured. Every row that existed before this column, and
  every key added since and not yet tested.
* **`[]`** — measured, and this endpoint reports no allowance. Tavily, always.
* **a list** — the windows it declared.

Collapsing the first two would put our own gap on screen as a fact about the
endpoint, which is the mistake §3.1 exists to prevent. And a null is never drawn
as a zero: an empty meter would say an account is exhausted (§1.1).

The reading arrives on the response to a real search, so there is nowhere to ask
for it on its own. It is therefore written by "Test connection" and carries the
moment it was taken, which is the same moment `verified_at` already records.

Revision ID: 0014_search_quota
Revises: 0013_attachments
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_search_quota"
down_revision: str | None = "0013_attachments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("provider_profiles", sa.Column("quota", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("provider_profiles", "quota")
