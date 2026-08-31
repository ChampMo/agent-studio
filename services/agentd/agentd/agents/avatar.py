"""The avatar asset catalogue.

PROJECT_BRIEF.md §11: an avatar is **chosen from assets that exist**, never
generated. That makes this list authoritative in three places at once — the
prompt shows it to the model, the validator rejects anything outside it, and the
scene in M5 will draw from it. If the model were free to invent
`hair: "flowing_silver_mane"`, nothing would notice until a sprite failed to
load three milestones from now.

Served over REST rather than shared as a file, for the same reason as the tool
registry: `events.schema.json` is the only contract both sides must keep in sync
(§2.2, §15 row 11).
"""

from __future__ import annotations

from typing import Any

#: Every valid value, per slot. Adding an asset is an edit here plus the art.
AVATAR_SLOTS: dict[str, tuple[str, ...]] = {
    "body": ("slim", "average", "sturdy", "tall", "small"),
    "hair": (
        "short",
        "long",
        "ponytail",
        "buzz",
        "curly",
        "bun",
        "bald",
        "hooded",
    ),
    "outfit": (
        "lab_coat",
        "hoodie",
        "blazer",
        "robe",
        "overalls",
        "uniform",
        "armor",
        "cloak",
    ),
    "palette": (
        "slate",
        "amber",
        "teal",
        "rose",
        "violet",
        "moss",
        "sand",
        "ink",
    ),
}


class InvalidAvatar(ValueError):
    """Raised with every problem at once, so a retry can fix them in one pass."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


def default_avatar() -> dict[str, str]:
    return {slot: values[0] for slot, values in AVATAR_SLOTS.items()}


def validate_avatar(config: Any) -> dict[str, str]:
    """Return a clean avatar config, or raise with everything that is wrong.

    Reporting all problems together matters: the retry feeds this message back
    to the model, and fixing one slot per round trip would cost four calls to
    settle a fully invented avatar.
    """
    if not isinstance(config, dict):
        raise InvalidAvatar([f"avatar_config must be an object, got {type(config).__name__}"])

    problems: list[str] = []
    clean: dict[str, str] = {}

    for slot, allowed in AVATAR_SLOTS.items():
        value = config.get(slot)
        if value is None:
            problems.append(f"{slot} is missing; choose one of: {', '.join(allowed)}")
        elif value not in allowed:
            problems.append(
                f"{slot}={value!r} is not an available asset; choose one of: "
                f"{', '.join(allowed)}"
            )
        else:
            clean[slot] = value

    for unknown in set(config) - set(AVATAR_SLOTS):
        problems.append(f"{unknown!r} is not an avatar slot")

    if problems:
        raise InvalidAvatar(problems)
    return clean


def catalogue() -> dict[str, list[str]]:
    """The wire form, for the frontend picker and the generator prompt."""
    return {slot: list(values) for slot, values in AVATAR_SLOTS.items()}
