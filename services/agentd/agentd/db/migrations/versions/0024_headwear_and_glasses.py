"""`prop` becomes `headwear` and `glasses`, because the drawings do not overlap.

Twenty-three accessories arrived and they sit in two places on the cat: over
the eyes, and on top of the head. Measured rather than eyeballed — a pair of
glasses shares **zero** pixels with the cap and zero with the ear bows, while
a head bow over the ear bows shares 220. So the eyes get a slot of their own
and everything on the head shares one, and an agent can wear glasses and a
bow at the same time, which is what the art was drawn for.

Splitting a slot does not multiply the artwork. Each slot is one overlay
layer on the same 100x100 canvas, so the two cost 17 + 8 drawings rather than
17 x 8 characters — the same arithmetic that keeps four breeds from costing
2,560 cats.

**Only two of the eight old values have an honest destination**, and this is
the paragraph that says so rather than a mapping that quietly invents six.
`prop` was a slot held open for art: `glasses` and `cap` were drawn, and
`scarf`, `headphones`, `bandana` and `eyepatch` never were, so those four
become nothing. Folding them onto a hat somebody did not choose would be
writing a preference into the record that nobody expressed (§5.1).

`bow_tie` is the one guess, and it is deliberate. The bow that exists is worn
on the head rather than at the neck — the same object in the wrong place —
and the alternative is flattening those agents into the undressed default
alongside the four above. Kept distinct, and named here as a guess.

On the database this runs against, every agent holds `prop: "none"`: the
column has been in this shape for one session and the picker showed eight
identical previews because no drawing existed for any of them. So the fold is
a formality on these rows, and the rule still has to be written down for the
machine that ran the build before it.

Straight through `migrate_avatar`, the one place that translates, exactly as
0019, 0021, 0022 and 0023 did.

**`missions.roster_snapshot` is deliberately not touched**, as in all four. It
is the record of what a finished run used, and rewriting it would make an old
mission claim a look it never had (§5.1). A replay therefore hands `lookFor` a
`prop` this build no longer has; it falls back, and the cat wears nothing
rather than something this build picked for it (§8).

Revision ID: 0024_headwear_and_glasses
Revises: 0023_drawn_cats
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

from agentd.agents.avatar import migrate_avatar

revision = "0024_headwear_and_glasses"
down_revision = "0023_drawn_cats"
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
            # place. Raising here would leave the table half converted.
            config = None
        bind.execute(
            sa.text("UPDATE agents SET avatar_config = :a WHERE id = :i"),
            {"a": json.dumps(migrate_avatar(config)), "i": agent_id},
        )


def downgrade() -> None:
    # Two slots cannot go back into one without deciding which of a hat and a
    # pair of glasses to throw away, and nothing records which the agent had
    # first. A downgrade that guessed would write something that was never
    # true (§5.1). Same reason 0020 through 0023 are empty.
    pass
