"""One place for settings that belong to the app, not to an agent (§16.4)

`autonomy` — when to ask before acting — was a field on every agent, set in the
agent creator, buried under the tool list. That put a security decision in the
wrong place twice over: it is asked *per agent*, so a team of five had five
answers to a question the person only ever means once; and it lived on a page
nobody opens while work is happening, when it is a choice you want in front of
you as the run starts.

So it moves here, alongside the composer, as a single value every run uses.
`agents.autonomy` stays in the schema and keeps its value — deleting it would
rewrite what old missions were run under, and the snapshot of a finished run
still carries whatever was in force at the time (§5.1).

Revision ID: 0012_app_settings
Revises: 0011_model_prices
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012_app_settings"
down_revision: str | None = "0011_model_prices"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
