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
#: **This list is the art that exists, and nothing else** (§11). Four cats were
#: drawn, each at two widths, with four collars — so there are four breeds, two
#: sizes and five collar values, not the nine and five and five that were here
#: when the art was a tinted placeholder and any number was as cheap as any
#: other. A catalogue longer than the drawings is a picker where several
#: options produce the same cat, which is a control claiming to do something it
#: does not (§1.1).
#:
#: A cat is composited from four layers on one 100x100 canvas: the face
#: (breed x size), the eyes (per breed, and they differ — marmalade's are
#: black, siamese's blue, bombay's gold), the mouth (one drawing shared by all
#: four), and the collar. Eyes and mouth each have two frames, which is what
#: makes a cat blink and talk; neither is a slot, because neither is a choice.
#:
#: **`prop` became `headwear` and `glasses`**, because the drawings arrived and
#: they do not overlap. Measured rather than assumed: a pair of glasses shares
#: zero pixels with a cap and zero with the ear bows, so a cat can wear both
#: and one slot could only ever show one of them. What *does* collide is
#: everything on top of the head — a head bow over the ear bows is 220 shared
#: pixels — so those stay one slot between them. The slots are named for the
#: place on the cat rather than the thing, because the place is what decides
#: what can be worn at once.
#:
#: Separate slots do not multiply the art. Each is one overlay layer, so the
#: two cost 17 + 8 drawings rather than 17 x 8 characters — the same
#: arithmetic that keeps four breeds from costing 2,560 cats.
AVATAR_SLOTS: dict[str, tuple[str, ...]] = {
    #: The four drawn cats. The names are the four the previous catalogue
    #: already used for these looks, so an agent that was any of them keeps
    #: exactly the face it had.
    "breed": ("marmalade", "siamese", "bombay", "tuxedo"),
    #: Two drawings, not a scale factor. `Face-normal` and `Face-fat` are
    #: separate pictures, which is why this is two values and not five: the
    #: other three were a squash applied to one drawing, and a squashed cat is
    #: not a rounder cat.
    "size": ("normal", "fat"),
    #: Worn on top of the head, where only one thing fits. Three shapes were
    #: drawn — a big bow, a cap, and a small bow on each ear — so a value
    #: names the shape and its colour, because "red" alone would not say which
    #: of three red things was meant.
    "headwear": (
        "none",
        "bow_red",
        "bow_amber",
        "bow_green",
        "bow_jade",
        "bow_rose",
        "bow_violet",
        "bow_orchid",
        "bow_blue",
        "bow_pink",
        "cap_tan",
        "cap_brown",
        "ears_blue",
        "ears_violet",
        "ears_rose",
        "ears_brown",
        "ears_amber",
    ),
    #: One shape in seven colours, so the values are the colours — the same
    #: form the collars take, for the same reason.
    "glasses": ("none", "blue", "red", "amber", "green", "teal", "brown", "pink"),
    #: Four collars were drawn, each in a colour, each with the same bell.
    #: `none` is first and is what an agent nobody dressed gets.
    "collar": ("none", "blue", "green", "pink", "red"),
}

#: The one slot that became two, and what each of its values becomes.
#:
#: Written as a table of *sets of slots* rather than as another entry in
#: `RETIRED`, because everything there answers "what is this value now" with
#: one value, and a slot that splits cannot. An old `prop` is read once and
#: lands on as many of the new slots as it has a meaning for.
#:
#: Only two of the eight have anywhere honest to go. `glasses` is the shape
#: that was drawn, and `cap` is; the rest — a scarf, headphones, a bandana, an
#: eyepatch — were names in a catalogue held open for art that was never made,
#: so they become nothing rather than a hat somebody did not choose (§5.1).
#: `bow_tie` is the one guess: the bow that exists is worn on the head rather
#: than at the neck, which is the wrong place for the same object, and it
#: keeps those agents distinct instead of flattening them into the undressed
#: default.
PROP_SPLIT: dict[str, dict[str, str]] = {
    "none": {},
    "glasses": {"glasses": "brown"},
    "cap": {"headwear": "cap_brown"},
    "bow_tie": {"headwear": "bow_red"},
    "scarf": {},
    "headphones": {},
    "bandana": {},
    "eyepatch": {},
}

#: What each old value becomes, for agents created before the catalogue changed.
#:
#: **One-to-one wherever it can be**, which is the rule migration 0019 wrote
#: down and this change nearly broke: a mapping that collapses several old
#: looks onto one cat makes agents that were deliberately different start
#: looking alike, and the person who chose them has no way to tell why.
#:
#: `coat` -> `breed` keeps that promise exactly: eight patterns, eight breeds,
#: nobody's pattern collides with anybody else's. What is dropped is the
#: separately chosen `palette`, because a breed brings its own colouring — so
#: some cats change colour, and none of them becomes another cat.
#:
#: `outfit` -> `prop` cannot be honest in the same way. A lab coat is not a
#: pair of glasses and no pairing makes it one. These are **guesses**, chosen
#: to keep everyone distinct rather than to be right, and the one thing they
#: get correct is that no two old outfits land on the same prop.
#:
#: This rewrites a **preference**, not a record. `missions.roster_snapshot`
#: keeps whatever was frozen at launch, so replaying an old run still reports
#: the look it actually ran with — this build simply cannot draw it, and falls
#: back to the default cat (§5.1, §8).
LEGACY_AVATAR: dict[str, dict[str, str]] = {
    #: The four-slot cat catalogue that came before this one.
    #: The three-slot catalogue this replaced. `breed` carried the whole of
    #: what a cat looked like, so it is what a picture is chosen by — the
    #: names did not change, which is why this map is an identity and every
    #: cat keeps its own face.
    #:
    #: `prop` and `size` have nowhere to go and are dropped. That is the cost
    #: of one picture per cat: two cats that differed only by a hat are now
    #: the same cat, and the migration says so rather than inventing a
    #: distinction the art does not have.
    "breed": {
        "tabby": "tabby",
        "tuxedo": "tuxedo",
        "calico": "calico",
        "siamese": "siamese",
        "bengal": "bengal",
        "maine_coon": "maine_coon",
        "bombay": "bombay",
        "tortie": "tortie",
        "marmalade": "marmalade",
    },
    #: The one-slot catalogue, which existed for exactly one build. `cat` was
    #: `breed` under another name — the values never changed — so this is an
    #: identity and every agent keeps the face it had.
    #:
    #: It is here because that build reached a real database. A machine that
    #: ran it has agents holding `{"cat": ...}`, and a chain that only knew the
    #: three-slot names would answer every one of them with the default cat.
    "cat": {
        "tabby": "tabby",
        "tuxedo": "tuxedo",
        "calico": "calico",
        "siamese": "siamese",
        "bengal": "bengal",
        "maine_coon": "maine_coon",
        "bombay": "bombay",
        "tortie": "tortie",
        "marmalade": "marmalade",
    },
    "coat": {
        "tabby": "tabby",
        "tuxedo": "tuxedo",
        "calico": "calico",
        "point": "siamese",
        "spotted": "bengal",
        "shaggy": "maine_coon",
        "sleek": "bombay",
        "patched": "tortie",
    },
    "outfit": {
        "lab_coat": "glasses",
        "hoodie": "cap",
        "blazer": "bow_tie",
        "apron": "bandana",
        "overalls": "none",
        "uniform": "headphones",
        "vest": "eyepatch",
        "scarf": "scarf",
        #: The human catalogue's three that the cat one renamed. 0019 should
        #: have converted every row already, so these can only matter if that
        #: is not true — which is the reason to write them rather than the
        #: reason not to. They may share a target with a cat-era value above:
        #: the two vocabularies never appear in one row, so within either era
        #: the mapping is still one-to-one.
        "robe": "bandana",
        "armor": "eyepatch",
        "cloak": "scarf",
    },
    "build": {
        "lithe": "slim",
        "average": "average",
        "stocky": "plump",
        #: `lanky` and `small` were a height and an overall scale, and the axis
        #: they land on has neither. Ranked by the width they actually drew —
        #: 0.92 and 0.94 against average's 1.0 — which is the only property of
        #: them the new axis can carry. A guess, like the outfits, and distinct
        #: for the same reason.
        "lanky": "skinny",
        "small": "chonky",
    },
    #: The five-value size list this replaced, one session old and never
    #: released. Present so a database that ran that build lands somewhere
    #: valid rather than failing its next save.
    "size": {
        "slim": "slim",
        "average": "average",
        "stout": "plump",
        "tall": "skinny",
        "small": "chonky",
    },
    #: And the human catalogue before that, so a row that somehow missed 0019
    #: still lands somewhere sensible rather than on the default for everything.
    "body": {
        "slim": "slim",
        "average": "average",
        "sturdy": "plump",
        "tall": "skinny",
        "small": "chonky",
    },
    "hair": {
        "short": "bombay",
        "long": "maine_coon",
        "ponytail": "tabby",
        "buzz": "bengal",
        "curly": "calico",
        "bun": "tortie",
        "bald": "tuxedo",
        "hooded": "siamese",
    },
}

#: Values a previous catalogue had and this one does not, and what each
#: becomes.
#:
#: Keyed by the **current** slot rather than by an old slot name, because these
#: are not a different vocabulary — they are this vocabulary, shortened. Every
#: map in `LEGACY_AVATAR` above still resolves to the catalogue *it* was written
#: against, and this is what carries that answer the last step into the
#: catalogue that exists now. Keeping the two separate is what let nine breeds
#: become four without touching six tables that are each correct about their
#: own era.
#:
#: **Breeds fold by what the cat looks like.** Five drawings went away and the
#: agents who had them have to land on one of the four that did not:
#: everything with orange in it goes to the marmalade, everything grey, white
#: or patched goes to the tuxedo. Two agents that looked different can now look
#: alike, and that is the honest cost of four drawings rather than nine — the
#: rule 0019 wrote down held for as long as the catalogue was tints, and cannot
#: hold when the art is hand-drawn.
#:
#: **Sizes fold by which drawing they are nearest.** `skinny` and `slim` were
#: narrower than average, so all three become the normal cat; `plump` and
#: `chonky` were wider, so both become the fat one.
#:
#: **Collars fold to none**, and that needs saying. The old values named a
#: *kind* of collar — bell, tag, ribbon, studded — and the new ones name a
#: *colour*. There is no colour in "a bell", so picking one would be inventing
#: a choice nobody made (§5.1). Nothing is lost in practice: the slot is one
#: session old, was never drawn, and every row in the database holds `none`.
RETIRED: dict[str, dict[str, str]] = {
    "breed": {
        "bengal": "marmalade",
        "tortie": "marmalade",
        "tabby": "tuxedo",
        "calico": "tuxedo",
        "maine_coon": "tuxedo",
    },
    "size": {
        "average": "normal",
        "skinny": "normal",
        "slim": "normal",
        "plump": "fat",
        "chonky": "fat",
    },
    "collar": {
        "bell": "none",
        "tag": "none",
        "ribbon": "none",
        "studded": "none",
    },
}


#: Old slot key -> new one.
#:
#: `palette` is deliberately absent: colouring travels with the breed now, so
#: there is nowhere for a separately chosen one to go, and dropping it is the
#: documented cost of that fold. `collar` has no old name at all — nothing
#: before this catalogue described one — so it is filled with its default
#: rather than guessed at.
LEGACY_SLOTS = {
    # Two names for one choice, from catalogues that never coexisted: the human
    # one had `hair` and no `coat`, the cat one the reverse, and the one-slot
    # one had `cat` and neither. No config carries two of them, so the order
    # these are read in cannot matter.
    "cat": "breed",
    "coat": "breed",
    "hair": "breed",
    "outfit": "prop",
    "build": "size",
    "body": "size",
}


def _land(slot: str, value: Any) -> str | None:
    """One value against the current catalogue, folding a retired one on the way.

    Returns `None` for anything it cannot place, so the caller can try the next
    reading rather than writing a wrong answer.
    """
    if value in AVATAR_SLOTS[slot]:
        return str(value)
    folded = RETIRED.get(slot, {}).get(value)  # type: ignore[arg-type]
    return folded if folded in AVATAR_SLOTS[slot] else None


def migrate_avatar(config: Any) -> dict[str, str]:
    """Best effort at what an old avatar_config meant, for the migration.

    Anything it cannot place falls back to the default for that slot rather
    than raising: this runs over rows nobody is watching, and a migration that
    fails on one odd value would leave the table half-converted.

    **Two readings, each folded.** A value is tried as it stands first, because
    most rows already speak this vocabulary and only need shortening —
    `size: "chonky"` is a value this catalogue retired, not a foreign word. Only
    if that fails is `LEGACY_AVATAR` consulted, and whatever *it* answers is
    folded too, because those tables were written against the catalogue of
    their own era: `coat: "patched"` resolves to `tortie`, which is itself now
    retired, and has to take the second step to `marmalade`.

    `palette` is dropped rather than mapped, and that is the one lossy step
    that cannot be undone. It has no slot to go to — the breed carries the
    colouring now.

    `prop` is the one slot that does not resolve to a single value, because it
    became two. `PROP_SPLIT` says what each of its values means in the
    catalogue that replaced it.
    """
    out = default_avatar()
    if not isinstance(config, dict):
        return out
    for old_slot, value in config.items():
        slot = LEGACY_SLOTS.get(old_slot, old_slot)
        if slot == "prop":
            # The slot that became two. An `outfit` is a prop under the
            # previous catalogue's name, so it is resolved to one first and
            # then split across the slots that replaced it.
            prop = value if value in PROP_SPLIT else LEGACY_AVATAR.get(old_slot, {}).get(value)
            out.update(PROP_SPLIT.get(prop, {}))
            continue
        if slot not in AVATAR_SLOTS:
            continue
        landed = _land(slot, value) or _land(
            slot, LEGACY_AVATAR.get(old_slot, {}).get(value)
        )
        if landed is not None:
            out[slot] = landed
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
