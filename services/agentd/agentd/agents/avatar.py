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
#:
#: Rewritten for the cat office. The slot *keys* changed too — `body` became
#: `build` and `hair` became `coat` — because a cat has no hair and a slot
#: named for something the art does not draw is a name that has to be
#: explained every time anyone reads it.
#:
#: Two of the four cost no artwork at all, which is what makes 5 x 8 x 8 x 8
#: tractable: `build` is a scale multiplier and `palette` is a tint, exactly as
#: `BODIES` and `PALETTES` already worked before any of this. So the sheet only
#: has to carry `coat` x `outfit`, and those are drawn as separate layers over
#: one base cat rather than as 64 whole characters.
AVATAR_SLOTS: dict[str, tuple[str, ...]] = {
    #: Proportions, not stats (§1.1). Drawn by scaling one silhouette.
    "build": ("lithe", "average", "stocky", "lanky", "small"),
    #: Fur pattern. An overlay on the base cat, so eight of these is eight
    #: stencils rather than eight cats.
    "coat": (
        "tabby",
        "tuxedo",
        "calico",
        "point",
        "spotted",
        "shaggy",
        "sleek",
        "patched",
    ),
    #: What they wear to the office. Also an overlay.
    "outfit": (
        "lab_coat",
        "hoodie",
        "blazer",
        "apron",
        "overalls",
        "uniform",
        "vest",
        "scarf",
    ),
    #: Fur colour, applied as a tint. No extra frames.
    "palette": (
        "ginger",
        "charcoal",
        "cream",
        "grey",
        "brown",
        "snow",
        "ink",
        "smoke",
    ),
}

#: What each old value becomes, for agents created before the office had cats.
#:
#: One-to-one on purpose. A mapping that collapsed several old looks onto one
#: cat would make agents that were deliberately different start looking alike,
#: and the person who chose those looks would have no way to tell why.
#:
#: This rewrites a **preference**, not a record. `missions.roster_snapshot`
#: keeps whatever was frozen at launch, so replaying an old run still reports
#: the look it actually ran with — this build simply cannot draw it, and falls
#: back to the default cat (§5.1, §8).
LEGACY_AVATAR: dict[str, dict[str, str]] = {
    "body": {
        "slim": "lithe",
        "average": "average",
        "sturdy": "stocky",
        "tall": "lanky",
        "small": "small",
    },
    "hair": {
        "short": "sleek",
        "long": "shaggy",
        "ponytail": "tabby",
        "buzz": "spotted",
        "curly": "calico",
        "bun": "patched",
        "bald": "tuxedo",
        "hooded": "point",
    },
    "outfit": {
        "lab_coat": "lab_coat",
        "hoodie": "hoodie",
        "blazer": "blazer",
        "robe": "apron",
        "overalls": "overalls",
        "uniform": "uniform",
        "armor": "vest",
        "cloak": "scarf",
    },
    "palette": {
        "slate": "grey",
        "amber": "ginger",
        "teal": "smoke",
        "rose": "cream",
        "violet": "ink",
        "moss": "brown",
        "sand": "snow",
        "ink": "charcoal",
    },
}

#: Old slot key -> new one.
LEGACY_SLOTS = {"body": "build", "hair": "coat"}


def migrate_avatar(config: Any) -> dict[str, str]:
    """Best effort at what an old avatar_config meant, for the migration.

    Anything it cannot place falls back to the default for that slot rather
    than raising: this runs over rows nobody is watching, and a migration that
    fails on one odd value would leave the table half-converted.
    """
    out = default_avatar()
    if not isinstance(config, dict):
        return out
    for old_slot, value in config.items():
        slot = LEGACY_SLOTS.get(old_slot, old_slot)
        if slot not in AVATAR_SLOTS:
            continue
        if value in AVATAR_SLOTS[slot]:
            out[slot] = value
            continue
        mapped = LEGACY_AVATAR.get(old_slot, {}).get(value)
        if mapped in AVATAR_SLOTS[slot]:
            out[slot] = mapped
    return out


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
