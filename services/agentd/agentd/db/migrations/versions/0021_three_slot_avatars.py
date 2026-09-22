"""Four avatar slots become three: breed, prop, size.

`coat` and `palette` were independent, so a tuxedo could be chosen in ginger —
a cat which does not exist. A breed carries its pattern and its colouring
together, which removes the pairs that were never real rather than merely
removing choice. `outfit` becomes `prop` because the scene draws portraits now
and a lab coat sits entirely below the crop. `build` becomes `size`, and that
one is not only a rename: the old values were a width, a height and an overall
scale at once, so "one step bigger" meant three different things depending on
where you started. `size` is a single axis — how round the cat is — which is
also the first time that slot has changed anything anyone can see, because both
renderers had been scaling uniformly and throwing the width away.

Straight through `migrate_avatar`, which is the one place that translates —
the same arrangement 0019 used, so there is a single table of what an old
value meant rather than one here and another in the app.

**One-to-one where it can be.** Eight coats land on eight breeds, so no two
agents that looked different start looking alike (the rule 0019 wrote down).
What is lost is the separately chosen `palette`: some cats change colour, and
none of them becomes another cat. `outfit` to `prop` cannot be honest in the
same way — a lab coat is not a pair of glasses — so those pairings are
documented guesses that at least keep everybody distinct.

**`missions.roster_snapshot` is deliberately not touched**, exactly as in 0019.
It is the record of what a finished run used, and rewriting it would make an
old mission claim a look it never had (§5.1). Replaying one therefore hands a
four-slot config to a build with three, and `lookFor` falls back — this build
saying plainly that it has no art for what was recorded (§8).

Revision ID: 0021_three_slot_avatars
Revises: 0020_leader_is_seat_zero
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

from agentd.agents.avatar import migrate_avatar

revision = "0021_three_slot_avatars"
down_revision = "0020_leader_is_seat_zero"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, avatar_config FROM agents")
    ).fetchall()

    for agent_id, raw in rows:
        try:
            config = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError):
            # A row whose JSON cannot be read still has to end up valid, and
            # `migrate_avatar` answers with the default for anything it cannot
            # place. A migration that raised here would leave the table half
            # converted, which is worse than one cat losing its markings.
            config = None
        bind.execute(
            sa.text("UPDATE agents SET avatar_config = :a WHERE id = :i"),
            {"a": json.dumps(migrate_avatar(config)), "i": agent_id},
        )


def downgrade() -> None:
    # Nothing to put back. The `palette` each agent had chosen is not recorded
    # anywhere once the breed has absorbed the colouring, and inventing one to
    # undo this with would be putting something in the record that was never
    # true of it (§5.1). Same reason 0020's downgrade is empty.
    pass
