"""Let `kind` be 'search' (§16.5)

M8 added a search endpoint kind everywhere in Python — the request model, the
provider serialiser, the tool registry, the UI — and not in the database. The
CHECK constraint written in 0001 still allowed exactly two values, so saving a
search endpoint failed with an IntegrityError every single time, and had never
once worked.

It went unnoticed because nothing inserted one. The adapters are tested against
recorded responses, `_has_search_provider` only reads, and no test created a
profile through the API. `test_settings_api.py` does now, which is the test that
would have caught this the day it was written.

Revision ID: 0009_search_kind
Revises: 0008_native_search
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0009_search_kind"
down_revision: str | None = "0008_native_search"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS_NOW = "kind IN ('openai_compatible', 'anthropic', 'search')"
KINDS_BEFORE = "kind IN ('openai_compatible', 'anthropic')"


def upgrade() -> None:
    # SQLite cannot alter a constraint, so `batch_alter_table` rebuilds the
    # table. Dropping and recreating in the same batch, for the reason recorded
    # in 0004: a constraint dropped in a separate batch is recreated against the
    # table as it was.
    with op.batch_alter_table("provider_profiles") as batch:
        batch.drop_constraint("ck_provider_kind", type_="check")
        batch.create_check_constraint("ck_provider_kind", KINDS_NOW)


def downgrade() -> None:
    with op.batch_alter_table("provider_profiles") as batch:
        batch.drop_constraint("ck_provider_kind", type_="check")
        batch.create_check_constraint("ck_provider_kind", KINDS_BEFORE)
