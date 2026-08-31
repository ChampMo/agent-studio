"""Built-in scene layouts.

PROJECT_BRIEF.md §5 keeps `scene_layout_id` as a TEXT column validated at the
app layer, with no `layouts` table (§13). This is that layer.

A layout owns the seat count, which is what makes `seat_index` checkable: a seat
that does not exist in the layout has nowhere to draw a character in M5, and the
database cannot know that. It can enforce that two members do not share a seat;
only this can say whether the seat is real.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Layout:
    id: str
    name: str
    seats: int
    description: str


LAYOUTS: dict[str, Layout] = {
    layout.id: layout
    for layout in (
        Layout("open_desks", "Open desks", 6, "Six desks in a shared room."),
        Layout("war_room", "War room", 4, "Four seats around one table."),
        Layout("workshop", "Workshop", 8, "Eight benches, two rows."),
        Layout("duo", "Duo", 2, "Two desks facing each other."),
    )
}

DEFAULT_LAYOUT = "open_desks"


def get(layout_id: str | None) -> Layout:
    """The layout, falling back to the default for an unknown id.

    Forward compatibility (§8) applies to stored data too: a team saved by a
    newer build may name a layout this one has never heard of, and the right
    answer is to render it somewhere rather than refuse to open it.
    """
    return LAYOUTS.get(layout_id or "", LAYOUTS[DEFAULT_LAYOUT])


def is_known(layout_id: str | None) -> bool:
    return layout_id in LAYOUTS


def catalogue() -> list[dict[str, object]]:
    return [
        {"id": l.id, "name": l.name, "seats": l.seats, "description": l.description}
        for l in LAYOUTS.values()
    ]
