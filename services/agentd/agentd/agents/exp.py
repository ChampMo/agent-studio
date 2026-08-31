"""Level, derived from exp (PROJECT_BRIEF.md §5, decision row 12).

A pure function rather than a column. Two copies of the same fact drift, and the
one that drifts is always the one nobody recomputed.

What *grants* exp is M4's problem — nothing awards any yet, and every agent
created in M2 sits at 0. The curve is here now so the roster card has something
honest to show, and so the shape is settled before missions start feeding it.
"""

from __future__ import annotations

#: Exp needed to reach each level. Quadratic-ish: early levels arrive quickly so
#: a new agent visibly progresses, later ones slow down.
_STEP = 100


def level_for(exp: int) -> int:
    """Level 1 at 0 exp. Level n at `_STEP * (n-1) * n / 2`."""
    if exp < 0:
        raise ValueError("exp cannot be negative")
    level = 1
    needed = _STEP
    remaining = exp
    while remaining >= needed:
        remaining -= needed
        level += 1
        needed += _STEP
    return level


def exp_for_level(level: int) -> int:
    """Total exp required to reach a level. The inverse of `level_for`."""
    if level < 1:
        raise ValueError("levels start at 1")
    return _STEP * (level - 1) * level // 2


def progress(exp: int) -> dict[str, int]:
    """Everything a roster card needs, computed in one place so the bar and the
    number can never disagree."""
    level = level_for(exp)
    floor = exp_for_level(level)
    ceiling = exp_for_level(level + 1)
    return {
        "level": level,
        "exp": exp,
        "into_level": exp - floor,
        "level_span": ceiling - floor,
    }
