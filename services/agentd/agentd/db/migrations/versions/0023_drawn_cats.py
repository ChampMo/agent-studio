"""The catalogue shrinks to the cats that were actually drawn.

Four cats arrived, each at two widths, with four collars. So `breed` goes from
nine values to four, `size` from five to two, and `collar`'s five names for
*kinds* of collar become five for *colours*. `prop` is untouched and still has
no art: the drawings are being made, and the slot is held open rather than
removed and added back, which would be two more migrations over one column.

**This breaks the one-to-one promise, and that is the point of this docstring.**
Migration 0019 wrote down the rule that a mapping must never collapse two
looks onto one cat, because the person who chose them has no way to tell why
their agents started matching. That rule held while a cat was a tint over a
shared sprite and a tenth value cost nothing. It cannot hold against hand-drawn
art: nine breeds do not fit into four drawings.

So five breeds have no home and fold by what the cat looks like — everything
with orange in it onto the marmalade, everything grey, white or patched onto
the tuxedo. On the database this runs against, that is:

    bombay   7 agents  -> bombay      (keeps its face)
    tortie   4 agents  -> marmalade
    bengal   1 agent   -> marmalade

Two faces across twelve agents, where there were three. Nothing here can
recover the difference, and the four collar colours are the app's answer to it:
they are a real choice that does have art, and they distinguish more agents
than the five folded breeds did.

Sizes fold to the nearest drawing — `skinny` and `slim` were narrower than
average so all three become `normal`, `plump` and `chonky` become `fat`.
Collars fold to `none`, because the old values named a kind and the new ones
name a colour, and there is no colour in "a bell". No row is affected: that
slot is one session old, was never drawn, and every agent holds `none`.

Straight through `migrate_avatar`, the one place that translates, exactly as
0019, 0021 and 0022 did.

**`missions.roster_snapshot` is deliberately not touched**, as in all three.
It is the record of what a finished run used, and rewriting it would make an
old mission claim a look it never had (§5.1). Replaying one therefore hands
`lookFor` a breed and a size this build no longer has, and it falls back to
the default cat — this build saying plainly that it has no drawing for what
was recorded (§8). That is a visible loss of replay fidelity and it is the
honest side of the trade.

Revision ID: 0023_drawn_cats
Revises: 0022_collar_and_size_art
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

from agentd.agents.avatar import migrate_avatar

revision = "0023_drawn_cats"
down_revision = "0022_collar_and_size_art"
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
    # Five breeds and three sizes went into four and two. Which of the folded
    # values an agent used to hold is not recorded anywhere afterwards, so
    # there is nothing to put back and a downgrade that guessed would write
    # something that was never true (§5.1). Same reason 0020, 0021 and 0022
    # are empty.
    pass
