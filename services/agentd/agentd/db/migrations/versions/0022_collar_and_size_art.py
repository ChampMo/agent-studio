"""A fourth avatar slot: collar.

`breed`, `prop` and `size` stay exactly as 0021 left them. What is added is
`collar`, and every existing agent gets `none` — the value that means nobody
chose one. Filling it with a real collar would be putting a decision in the
record that was never made (§5.1).

Straight through `migrate_avatar`, which is the one place that translates —
the same arrangement 0019 and 0021 used, so there is a single table of what an
old value meant rather than one here and another in the app.

**It also has to catch a database that ran the one-picture build.** For part of
one afternoon this project had a single `cat` slot, and that reached the
database on the machine it was written on. Those rows hold `{"cat": "bombay"}`,
which the three-slot names do not recognise, so `LEGACY_SLOTS` carries `cat ->
breed` and the values are unchanged — every agent keeps its own face. What that
build discarded, the `prop` and the `size` each agent had chosen, is not
recoverable and is not invented here: those rows come back with the defaults,
and this migration says so rather than putting a guess in the record.

**`missions.roster_snapshot` is deliberately not touched**, exactly as in 0019
and 0021. It is the record of what a finished run used, and rewriting it would
make an old mission claim a look it never had. Replaying one hands a config
with no `collar` to a build with four slots, and `lookFor` falls back — this
build saying plainly it has no art for what was recorded (§8).

Revision ID: 0022_collar_and_size_art
Revises: 0021_three_slot_avatars
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

from agentd.agents.avatar import migrate_avatar

revision = "0022_collar_and_size_art"
down_revision = "0021_three_slot_avatars"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, avatar_config FROM agents")).fetchall()

    for agent_id, raw in rows:
        try:
            config = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError):
            # A row whose JSON cannot be read still has to end up valid, and
            # `migrate_avatar` answers with the default for anything it cannot
            # place. Raising here would leave the table half converted, which
            # is worse than one cat losing its markings.
            config = None
        bind.execute(
            sa.text("UPDATE agents SET avatar_config = :a WHERE id = :i"),
            {"a": json.dumps(migrate_avatar(config)), "i": agent_id},
        )


def downgrade() -> None:
    # Dropping the key back out is possible; putting back what the one-picture
    # build discarded is not, and a downgrade that quietly did half the job
    # would be worse than one that does none. Same reason 0020's and 0021's are
    # empty.
    pass
