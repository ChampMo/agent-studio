"""agent_memories — what an agent wrote down for itself (§16.7)

Per agent, not per mission: the point of `remember` is that something learned on
Tuesday is available on Thursday. A mission-scoped note would be a scratchpad,
which the conversation already is.

Search is by keyword, not by meaning. `sqlite-vec` is in the stack (§3) and
`enable_load_extension` is available on this machine, but nothing embeds
anything yet — and a `recall` that claimed to find related memories while
matching substrings would be the app lying about what it does (§1).

Revision ID: 0007_agent_memory
Revises: 0006_workspace_autonomy
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_agent_memory"
down_revision: str | None = "0006_workspace_autonomy"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_memories",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "agent_id",
            sa.String(),
            sa.ForeignKey("agents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Which mission it was written during. Not a scope — a memory is the
        # agent's — but a replay should be able to say where a note came from.
        sa.Column("mission_id", sa.String(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_agent_memories_agent", "agent_memories", ["agent_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_memories_agent", table_name="agent_memories")
    op.drop_table("agent_memories")
