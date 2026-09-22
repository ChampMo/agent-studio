"""Seat 0 is the leader.

Two facts had been kept in two columns — which desk somebody sits at, and
whether they are in charge — and nothing made them agree. The validator checks
that there is exactly one leader and says nothing about where they sit, so a
real five-person team on this machine had its leader in **seat 4** while the
room seated whoever held seat 0 at the head of the table. The picture stated
the wrong thing about who was running the work (§1).

They are one fact now: the member in seat 0 leads. This brings existing teams
into line by **swapping** the leader with whoever holds seat 0 — everyone else
keeps their desk, so a team is not reshuffled to move one person.

**`missions.roster_snapshot` is deliberately not touched.** It is the record of
what a finished run actually used, and rewriting it would make an old mission
claim an arrangement it never had (§5.1). Ten of the forty runs recorded on
this machine have their leader somewhere other than seat 0, and replaying them
must keep showing that — which is why `headForLeader` in the scene stays even
though no new run can need it.

Revision ID: 0020_leader_is_seat_zero
Revises: 0019_cat_avatars
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0020_leader_is_seat_zero"
down_revision = "0019_cat_avatars"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT team_id, agent_id, seat_index, role_in_team, overrides "
            "FROM team_members ORDER BY team_id, seat_index"
        )
    ).fetchall()

    by_team: dict[str, list[tuple]] = {}
    for row in rows:
        by_team.setdefault(row[0], []).append(row)

    for team_id, members in by_team.items():
        leader_seat = next((r[2] for r in members if r[3] == "leader"), None)

        seats = {r[2]: r for r in members}
        if leader_seat not in (None, 0):
            # Swap the leader with whoever holds seat 0. Everyone else keeps
            # their desk, so a team is not reshuffled to move one person.
            head = seats.get(0)
            seats[0] = seats[leader_seat]
            if head is not None:
                seats[leader_seat] = head
            else:
                del seats[leader_seat]

        # Rewritten wholesale rather than updated in place, for the reason
        # `set_members` gives: `UNIQUE(team_id, seat_index)` and the partial
        # leader index are both violated halfway through a swap done row by
        # row, and there is no ordering that avoids it. The first attempt
        # parked a row at seat -1 to get around that and hit
        # `ck_team_members_seat_non_negative` on the real database — the
        # constraint doing its job.
        bind.execute(
            sa.text("DELETE FROM team_members WHERE team_id = :t"), {"t": team_id}
        )
        for seat, row in sorted(seats.items()):
            bind.execute(
                sa.text(
                    "INSERT INTO team_members "
                    "(team_id, agent_id, seat_index, role_in_team, overrides) "
                    "VALUES (:t, :a, :s, :r, :o)"
                ),
                {
                    "t": team_id,
                    "a": row[1],
                    "s": seat,
                    "r": "leader" if seat == 0 else "member",
                    "o": row[4],
                },
            )


def downgrade() -> None:
    # Nothing to put back. The seats a leader used to sit in are not recorded
    # anywhere once they have been swapped, and inventing an arrangement to
    # undo this with would be worse than leaving it (§5.1).
    pass
