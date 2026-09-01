"""workspace_root, recent workspaces, and per-agent autonomy

The three columns M8 cannot start without (PROJECT_BRIEF.md §16.2, §16.4).

`missions.workspace_root` is on the *mission*, not the agent and not the team
(§15 row 29): one team has to be usable on several projects, the way an editor
opens whichever folder you point it at. Putting it on the team would mean
copying a team per project, and putting it on the agent would mean a team whose
members disagree about where they are.

`recent_workspaces` is a convenience list, never a permission. Choosing from it
runs the same validation as a path typed by hand — otherwise it would become a
way to skip the checks by having once passed them.

`agents.autonomy` decides when a tool call stops to ask (§16.4). The default is
`ask_dangerous`, so an agent created before this migration — every agent that
exists today — asks before `bash` and `web_fetch` rather than after.

Revision ID: 0006_workspace_autonomy
Revises: 0005_hitl_artifacts
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_workspace_autonomy"
down_revision: str | None = "0005_hitl_artifacts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

AUTONOMY = ("ask_always", "ask_dangerous", "trusted")


def upgrade() -> None:
    op.add_column("missions", sa.Column("workspace_root", sa.Text(), nullable=True))

    # Server default as well as a Python default: rows written by anything that
    # bypasses the model layer still get an answer, and the answer is the
    # cautious one.
    with op.batch_alter_table("agents") as batch:
        batch.add_column(
            sa.Column(
                "autonomy",
                sa.String(),
                nullable=False,
                server_default="ask_dangerous",
            )
        )
        batch.create_check_constraint(
            "ck_agents_autonomy",
            "autonomy IN ('ask_always', 'ask_dangerous', 'trusted')",
        )

    op.create_table(
        "recent_workspaces",
        # The path is the identity: choosing the same folder twice updates the
        # timestamp rather than growing the list.
        sa.Column("path", sa.Text(), primary_key=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_recent_workspaces_used", "recent_workspaces", ["last_used_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_recent_workspaces_used", table_name="recent_workspaces")
    op.drop_table("recent_workspaces")
    with op.batch_alter_table("agents") as batch:
        # Dropped in the same batch as the column: SQLite rebuilds the table
        # here, and a constraint left behind would be recreated against a column
        # that no longer exists (the lesson from 0004_drop_exp).
        batch.drop_constraint("ck_agents_autonomy", type_="check")
        batch.drop_column("autonomy")
    op.drop_column("missions", "workspace_root")
