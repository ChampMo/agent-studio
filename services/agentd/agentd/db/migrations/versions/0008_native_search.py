"""provider_profiles.native_search — search the endpoint runs for itself (§16.8)

Opt-in, and off for every profile that exists. It is not another search engine:
it is a different trust model. When it is on, the endpoint searches the web
during a completion and tells us afterwards, so this app never sees the call
before it happens. The approval gate cannot stop it, `redact_fields` never sees
its input, and the results come back as `encrypted_content` that nothing here
can read.

Stored on the profile rather than the agent because it is a property of the
endpoint's configuration: every agent pointed at that profile gets it.

Revision ID: 0008_native_search
Revises: 0007_agent_memory
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008_native_search"
down_revision: str | None = "0007_agent_memory"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "provider_profiles",
        sa.Column(
            "native_search",
            sa.Boolean(),
            nullable=False,
            # Off, explicitly, for everything already saved. A flag that
            # defaulted on would turn a gate off for profiles whose owner never
            # asked for it.
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("provider_profiles", "native_search")
