"""Move every agent's avatar onto the cat catalogue.

The office is cats now, so `AVATAR_SLOTS` was rewritten — new keys (`build`,
`coat`) and new values. Every agent created before this holds a config the
validator would refuse, which matters because `AgentService` re-checks on
**edit** as well as create: without this, opening any existing agent and
pressing save would fail on an avatar nobody had touched.

`missions.roster_snapshot` is deliberately **not** migrated. It is the record of
what a run actually used, and rewriting it would make a finished mission claim
a look it never had (§5.1). Replaying an old run draws the default cat instead,
which is this build honestly saying it has no art for what was recorded (§8).

Revision ID: 0019_cat_avatars
Revises: 0018_task_counts
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0019_cat_avatars"
down_revision = "0018_task_counts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Imported here rather than at module scope: Alembic loads every revision
    # to build the chain, and a migration that drags the app package in at
    # import time fails differently on a frozen build than in dev.
    from agentd.agents.avatar import migrate_avatar

    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, avatar_config FROM agents")).fetchall()
    for agent_id, raw in rows:
        try:
            current = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (TypeError, ValueError):
            current = {}
        bind.execute(
            sa.text("UPDATE agents SET avatar_config = :cfg WHERE id = :id"),
            {"cfg": json.dumps(migrate_avatar(current)), "id": agent_id},
        )


def downgrade() -> None:
    # There is no way back that would be honest. The old value is recoverable
    # only where the mapping happened to be one-to-one, and an agent created
    # after this has no old look to return to — it never had one.
    raise NotImplementedError("cat avatars are not reversible")
