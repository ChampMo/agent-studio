"""Migration 0020 moves the leader to seat 0.

Written after the first version of it failed on the real database. It parked a
row at `seat_index = -1` to get around `UNIQUE(team_id, seat_index)` during the
swap, and `ck_team_members_seat_non_negative` refused it — the constraint doing
exactly its job, on data no test had covered.

So this runs the real migration function against the shape that broke: WEB DEV,
five members, leader in **seat 4**.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa

_PATH = (
    Path(__file__).resolve().parents[1]
    / "agentd"
    / "db"
    / "migrations"
    / "versions"
    / "0020_leader_is_seat_zero.py"
)
_spec = importlib.util.spec_from_file_location("mig0020", _PATH)
assert _spec is not None and _spec.loader is not None
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

#: The constraints the real table carries. Copied rather than imported so the
#: test fails if a future migration drops one of them without noticing that
#: this migration relies on them holding.
SCHEMA = [
    """
    CREATE TABLE team_members (
        team_id      TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        seat_index   INTEGER NOT NULL,
        role_in_team TEXT NOT NULL,
        overrides    TEXT,
        CONSTRAINT uq_team_members_seat UNIQUE (team_id, seat_index),
        CONSTRAINT ck_team_members_role CHECK (role_in_team IN ('leader','member')),
        CONSTRAINT ck_team_members_seat_non_negative CHECK (seat_index >= 0)
    )
    """,
    """
    CREATE UNIQUE INDEX uq_team_one_leader
        ON team_members (team_id) WHERE role_in_team = 'leader'
    """,
]


def _run(rows: list[tuple[str, str, int, str]]) -> list[tuple]:
    """Apply the real migration to a throwaway database carrying these rows."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as bind:
        for statement in SCHEMA:
            bind.execute(sa.text(statement))
        for team, agent, seat, role in rows:
            bind.execute(
                sa.text(
                    "INSERT INTO team_members "
                    "(team_id, agent_id, seat_index, role_in_team, overrides) "
                    "VALUES (:t, :a, :s, :r, NULL)"
                ),
                {"t": team, "a": agent, "s": seat, "r": role},
            )

    with engine.begin() as bind:
        # `upgrade()` reaches for `op.get_bind()`; hand it this connection.
        original = mod.op
        mod.op = type("Shim", (), {"get_bind": staticmethod(lambda: bind)})()
        try:
            mod.upgrade()
        finally:
            mod.op = original

    with engine.begin() as bind:
        return list(
            bind.execute(
                sa.text(
                    "SELECT agent_id, seat_index, role_in_team FROM team_members "
                    "ORDER BY team_id, seat_index"
                )
            ).fetchall()
        )


def test_a_leader_in_the_last_seat_swaps_with_seat_zero() -> None:
    """WEB DEV, exactly as it is on this machine."""
    out = _run(
        [
            ("web", "tester", 0, "member"),
            ("web", "uxui", 1, "member"),
            ("web", "dev", 2, "member"),
            ("web", "ba", 3, "member"),
            ("web", "pm", 4, "leader"),
        ]
    )

    assert out == [
        ("pm", 0, "leader"),
        ("uxui", 1, "member"),
        ("dev", 2, "member"),
        ("ba", 3, "member"),
        # Whoever held the head takes the leader's old desk. Nobody is lost and
        # nobody else moves.
        ("tester", 4, "member"),
    ]


def test_a_team_already_in_order_is_left_alone() -> None:
    out = _run(
        [
            ("ok", "lead", 0, "leader"),
            ("ok", "hand", 1, "member"),
        ]
    )
    assert out == [("lead", 0, "leader"), ("hand", 1, "member")]


def test_a_leaderless_team_gains_one_from_seat_zero() -> None:
    """Half-built is a normal saved state, and seat 0 is what leads now."""
    out = _run([("wip", "a", 0, "member"), ("wip", "b", 1, "member")])
    assert out == [("a", 0, "leader"), ("b", 1, "member")]


def test_a_leader_with_seat_zero_empty_simply_moves() -> None:
    """Nobody to swap with, so the old seat is vacated rather than filled with
    a copy of them."""
    out = _run([("gap", "hand", 1, "member"), ("gap", "lead", 3, "leader")])
    assert out == [("lead", 0, "leader"), ("hand", 1, "member")]


def test_every_team_is_handled_independently() -> None:
    out = _run(
        [
            ("a", "a0", 0, "member"),
            ("a", "a1", 1, "leader"),
            ("b", "b0", 0, "leader"),
        ]
    )
    assert out == [("a1", 0, "leader"), ("a0", 1, "member"), ("b0", 0, "leader")]
