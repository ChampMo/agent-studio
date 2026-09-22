"""Generate the placeholder cat sheet, in the shape Aseprite exports.

This exists so the sprite pipeline can be finished and tested *before* any real
art is drawn. The output is deliberately the same two files Aseprite produces —
`cats.png` plus `cats.json` with a `meta.frameTags` block — so replacing this
art later is `File > Export Sprite Sheet` over the top and nothing in the app
changes.

What it draws is programmer pixel art and looks it. That is fine and is the
point: it proves the atlas, the layering, the tinting and the animation timing
are right, so the only thing left to judge afterwards is the drawing.

**Three layers, and only two of them cost art.** `size` is a scale multiplier
and a breed's colouring is a tint, so neither costs a frame. That leaves the
pattern over the base cat and a prop on top, drawn as separate rows and
stacked at runtime:

    row  0      the base cat            16 frames
    rows 1-8    one per pattern         16 frames each
    rows 9-15   one per head prop       16 frames each

Seven prop rows, not eight: `none` is a real choice in the catalogue and needs
no art, so the renderer skips the layer rather than asking for a frame named
after an absence.

Everything is drawn in white and greys. Pixi's tint multiplies, so a white
sprite takes the palette's colour exactly and a grey one keeps its shading
relative to it — which is why there is no colour anywhere in this file.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

CELL_W, CELL_H = 32, 40
OUT = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "public" / "sprites"

#: Every frame the scene can ask for, in sheet order. The names are the
#: animation each belongs to; `frameTags` below turns runs of them into the
#: animations Pixi plays.
FRAMES = [
    ("sit", 1),      # at the desk, facing it
    ("idle", 2),     # stood at the desk, breathing
    ("thinking", 3), # tail flicking
    ("working", 3),  # paws on the keyboard
    ("waiting", 2),  # one paw raised
    ("blocked", 1),  # shoulders down
    ("walk", 4),     # crossing the room
]
TOTAL = sum(n for _, n in FRAMES)

#: The pattern rows. These are the *art*, not the breed names — `palette.ts`
#: pairs each breed with the row it is drawn from, so two breeds could share a
#: pattern later without the sheet changing.
COATS = (
    "tabby", "tuxedo", "calico", "point",
    "spotted", "shaggy", "sleek", "patched", "marmalade",
)

#: What they wear, at head height.
#:
#: These replaced body outfits when the scene became portraits: the crop keeps
#: the top 22 of the 40-pixel cell, so a lab coat was drawn entirely below the
#: part anyone sees. Everything here sits on or beside the head.
#:
#: `none` has no row — a cat wearing nothing needs no art, and the renderer
#: skips the layer rather than asking for a frame that does not exist.
PROPS = (
    "glasses", "scarf", "cap", "headphones",
    "bow_tie", "bandana", "eyepatch",
)

WHITE = (255, 255, 255, 255)
#: Shading, kept as greys so the tint carries through proportionally.
SHADE = (176, 176, 176, 255)
DARK = (120, 120, 120, 255)
LINE = (64, 64, 64, 255)
NONE = (0, 0, 0, 0)


def pose_offsets(anim: str, frame: int) -> dict[str, float]:
    """How far the parts move, per frame. Small numbers: this is pixel art and
    a two-pixel bob is already a lot of movement at this size."""
    if anim == "idle":
        return {"bob": 0 if frame == 0 else 1, "lean": 0, "tail": 0, "arm": 0}
    if anim == "thinking":
        return {"bob": 0, "lean": -1, "tail": (0, 2, -2)[frame], "arm": 0, "head": -1}
    if anim == "working":
        return {"bob": 0, "lean": 1, "tail": 0, "arm": (0, 2, 1)[frame]}
    if anim == "waiting":
        return {"bob": 0 if frame == 0 else 1, "lean": 0, "tail": 1, "paw": 1}
    if anim == "blocked":
        return {"bob": 2, "lean": 1, "tail": 0, "arm": 0, "slump": 2}
    if anim == "walk":
        return {"bob": (0, 1, 0, 1)[frame], "lean": 0, "tail": (1, 0, -1, 0)[frame],
                "step": (0, 1, 0, -1)[frame]}
    return {"bob": 0, "lean": 0, "tail": 0, "arm": 0}


def draw_base(d: ImageDraw.ImageDraw, anim: str, frame: int) -> None:
    """One cat, standing on two legs, facing the room."""
    o = pose_offsets(anim, frame)
    bob = int(o.get("bob", 0))
    lean = int(o.get("lean", 0))
    slump = int(o.get("slump", 0))
    step = int(o.get("step", 0))
    sitting = anim == "sit"

    cx = 16
    ground = 38
    # Legs. Sitting folds them away; walking swings them.
    if not sitting:
        d.rectangle([cx - 5 + step, ground - 7, cx - 2 + step, ground], fill=SHADE)
        d.rectangle([cx + 1 - step, ground - 7, cx + 4 - step, ground], fill=SHADE)
        body_bottom = ground - 6
    else:
        d.rectangle([cx - 6, ground - 4, cx + 6, ground], fill=SHADE)
        body_bottom = ground - 3

    # Tail, behind the body.
    tail = int(o.get("tail", 0))
    d.line(
        [(cx + 6, body_bottom - 2), (cx + 10, body_bottom - 6 + tail),
         (cx + 9, body_bottom - 11 + tail * 2)],
        fill=SHADE, width=2,
    )

    # Body.
    top = body_bottom - 13 + bob + slump
    d.rounded_rectangle([cx - 6 + lean, top, cx + 6 + lean, body_bottom],
                        radius=3, fill=WHITE)

    # Arms.
    arm = int(o.get("arm", 0))
    if anim == "working":
        d.rectangle([cx - 8 + lean, top + 4, cx - 5 + lean, top + 8 + arm], fill=WHITE)
        d.rectangle([cx + 5 + lean, top + 4, cx + 8 + lean, top + 8 + arm], fill=WHITE)
    elif o.get("paw"):
        # One paw up: this is the pose that means "a question is waiting".
        d.rectangle([cx - 8 + lean, top + 1, cx - 5 + lean, top + 6], fill=WHITE)
        d.rectangle([cx + 5 + lean, top - 4, cx + 8 + lean, top + 3], fill=WHITE)
    else:
        d.rectangle([cx - 8 + lean, top + 3, cx - 5 + lean, top + 9], fill=WHITE)
        d.rectangle([cx + 5 + lean, top + 3, cx + 8 + lean, top + 9], fill=WHITE)

    # Head, with ears.
    hy = top - 11 + int(o.get("head", 0))
    hx = cx + lean
    d.rounded_rectangle([hx - 7, hy, hx + 7, hy + 12], radius=4, fill=WHITE)
    d.polygon([(hx - 7, hy + 2), (hx - 6, hy - 5), (hx - 2, hy + 1)], fill=WHITE)
    d.polygon([(hx + 7, hy + 2), (hx + 6, hy - 5), (hx + 2, hy + 1)], fill=WHITE)
    # Eyes and muzzle, drawn dark so they survive any tint.
    if not sitting:
        d.rectangle([hx - 4, hy + 5, hx - 3, hy + 6], fill=LINE)
        d.rectangle([hx + 3, hy + 5, hx + 4, hy + 6], fill=LINE)
    d.rectangle([hx - 1, hy + 8, hx, hy + 9], fill=DARK)


def draw_coat(d: ImageDraw.ImageDraw, coat: str, anim: str, frame: int) -> None:
    """The marking layer: a stencil that sits over the base and is tinted with
    the palette's second colour."""
    o = pose_offsets(anim, frame)
    bob, lean, slump = int(o.get("bob", 0)), int(o.get("lean", 0)), int(o.get("slump", 0))
    sitting = anim == "sit"
    cx, ground = 16, 38
    body_bottom = ground - (3 if sitting else 6)
    top = body_bottom - 13 + bob + slump
    hy, hx = top - 11 + int(o.get("head", 0)), cx + lean

    if coat == "tabby":
        for i in range(3):
            y = top + 2 + i * 3
            d.rectangle([cx - 5 + lean, y, cx + 5 + lean, y], fill=WHITE)
        d.rectangle([hx - 3, hy + 1, hx + 3, hy + 2], fill=WHITE)
    elif coat == "tuxedo":
        d.rounded_rectangle([cx - 3 + lean, top + 2, cx + 3 + lean, body_bottom],
                            radius=2, fill=WHITE)
    elif coat == "calico":
        d.rectangle([cx - 6 + lean, top, cx - 1 + lean, top + 6], fill=WHITE)
        d.rectangle([cx + 2 + lean, top + 5, cx + 6 + lean, body_bottom], fill=WHITE)
        d.rectangle([hx + 1, hy, hx + 7, hy + 5], fill=WHITE)
    elif coat == "point":
        d.rounded_rectangle([hx - 7, hy, hx + 7, hy + 5], radius=3, fill=WHITE)
        if not sitting:
            d.rectangle([cx - 5, ground - 3, cx - 2, ground], fill=WHITE)
            d.rectangle([cx + 1, ground - 3, cx + 4, ground], fill=WHITE)
    elif coat == "spotted":
        for x, y in ((-4, 2), (1, 4), (-2, 8), (3, 9)):
            d.rectangle([cx + x + lean, top + y, cx + x + 1 + lean, top + y + 1], fill=WHITE)
    elif coat == "shaggy":
        d.rectangle([cx - 7 + lean, top + 9, cx + 7 + lean, top + 11], fill=WHITE)
        d.polygon([(hx - 8, hy + 4), (hx - 6, hy + 1), (hx - 6, hy + 7)], fill=WHITE)
    elif coat == "sleek":
        d.rectangle([cx - 1 + lean, top + 1, cx + 1 + lean, top + 7], fill=WHITE)
    elif coat == "patched":
        d.rectangle([cx - 6 + lean, top + 3, cx - 2 + lean, top + 9], fill=WHITE)
        d.rectangle([hx - 6, hy + 2, hx - 2, hy + 7], fill=WHITE)
    elif coat == "marmalade":
        # Pale cheeks and pale inner ears.
        #
        # The only pattern whose marking is *lighter* than the fur, which is
        # why it is a row of its own rather than a recolour of `tabby`: every
        # other one puts a darker colour on top, and the tint that makes this
        # one work would make those look bleached.
        #
        # Two cheeks with a gap rather than one muzzle, because this layer is
        # composited over the base and a solid patch would paint out the nose
        # the base drew. Leaving `hx - 1 .. hx` clear keeps it.
        d.rounded_rectangle([hx - 6, hy + 7, hx - 2, hy + 11], radius=2, fill=WHITE)
        d.rounded_rectangle([hx + 2, hy + 7, hx + 6, hy + 11], radius=2, fill=WHITE)
        d.polygon([(hx - 6, hy + 1), (hx - 5, hy - 3), (hx - 3, hy + 1)], fill=WHITE)
        d.polygon([(hx + 6, hy + 1), (hx + 5, hy - 3), (hx + 3, hy + 1)], fill=WHITE)
        # A chest patch, so the body is not bare if a full-length pose is ever
        # drawn again.
        d.rounded_rectangle(
            [cx - 3 + lean, top + 4, cx + 3 + lean, top + 9], radius=2, fill=WHITE
        )


def draw_prop(d: ImageDraw.ImageDraw, prop: str, anim: str, frame: int) -> None:
    """What they wear on their head, tinted with the breed's cloth colour.

    Everything here is placed off the head box `draw_base` draws — 14 wide by
    12 tall at `(hx, hy)`, with ears rising to `hy - 5`. Keeping the same
    arithmetic rather than hard numbers is what makes a prop follow the head
    when a pose leans or bobs; a fixed rectangle would float free of the cat
    on every frame but the resting one.
    """
    o = pose_offsets(anim, frame)
    bob, lean, slump = int(o.get("bob", 0)), int(o.get("lean", 0)), int(o.get("slump", 0))
    sitting = anim == "sit"
    cx, ground = 16, 38
    body_bottom = ground - (3 if sitting else 6)
    top = body_bottom - 13 + bob + slump
    hy, hx = top - 11 + int(o.get("head", 0)), cx + lean

    if prop == "glasses":
        # Two lenses on the eye line, joined over the muzzle.
        d.rectangle([hx - 5, hy + 4, hx - 2, hy + 7], fill=WHITE)
        d.rectangle([hx + 2, hy + 4, hx + 5, hy + 7], fill=WHITE)
        d.rectangle([hx - 1, hy + 5, hx + 1, hy + 6], fill=SHADE)
        d.rectangle([hx - 4, hy + 5, hx - 3, hy + 6], fill=DARK)
        d.rectangle([hx + 3, hy + 5, hx + 4, hy + 6], fill=DARK)
    elif prop == "scarf":
        # Round the neck, with one end hanging. The only prop that sits below
        # the head, and it is still inside the crop.
        d.rectangle([hx - 6, hy + 11, hx + 6, hy + 13], fill=WHITE)
        d.rectangle([hx + 2, hy + 13, hx + 4, hy + 18], fill=SHADE)
    elif prop == "cap":
        # A crown and a peak, sitting between the ears.
        d.rounded_rectangle([hx - 6, hy - 1, hx + 6, hy + 3], radius=2, fill=WHITE)
        d.rectangle([hx - 7, hy + 3, hx + 2, hy + 4], fill=SHADE)
    elif prop == "headphones":
        # A band over the top and a cup at each ear.
        d.rectangle([hx - 6, hy - 3, hx + 6, hy - 2], fill=WHITE)
        d.rectangle([hx - 8, hy - 2, hx - 6, hy + 4], fill=WHITE)
        d.rectangle([hx + 6, hy - 2, hx + 8, hy + 4], fill=WHITE)
        d.rectangle([hx - 8, hy, hx - 7, hy + 2], fill=DARK)
        d.rectangle([hx + 7, hy, hx + 8, hy + 2], fill=DARK)
    elif prop == "bow_tie":
        # Under the chin: two wings and a knot.
        d.polygon([(hx - 5, hy + 11), (hx - 1, hy + 13), (hx - 5, hy + 15)], fill=WHITE)
        d.polygon([(hx + 5, hy + 11), (hx + 1, hy + 13), (hx + 5, hy + 15)], fill=WHITE)
        d.rectangle([hx - 1, hy + 12, hx + 1, hy + 14], fill=SHADE)
    elif prop == "bandana":
        # Tied over the crown, knot to one side.
        d.polygon([(hx - 7, hy + 3), (hx, hy - 2), (hx + 7, hy + 3)], fill=WHITE)
        d.rectangle([hx - 7, hy + 3, hx + 7, hy + 4], fill=WHITE)
        d.rectangle([hx + 6, hy + 4, hx + 9, hy + 7], fill=SHADE)
    elif prop == "eyepatch":
        # One eye, and the strap that holds it.
        d.rectangle([hx + 2, hy + 3, hx + 6, hy + 8], fill=WHITE)
        d.rectangle([hx - 7, hy + 2, hx + 2, hy + 3], fill=SHADE)


def build() -> None:
    rows = 1 + len(COATS) + len(PROPS)
    sheet = Image.new("RGBA", (CELL_W * TOTAL, CELL_H * rows), NONE)

    def cell(col: int, row: int):
        img = Image.new("RGBA", (CELL_W, CELL_H), NONE)
        return img, ImageDraw.Draw(img), (col * CELL_W, row * CELL_H)

    frames: dict[str, dict] = {}
    tags: list[dict] = []

    def emit(row_name: str, row: int, painter) -> None:
        index = 0
        for anim, count in FRAMES:
            start = index
            for frame in range(count):
                img, d, at = cell(index, row)
                painter(d, anim, frame)
                sheet.alpha_composite(img, at)
                name = f"{row_name}.{anim}.{frame}"
                frames[name] = {
                    "frame": {"x": at[0], "y": at[1], "w": CELL_W, "h": CELL_H},
                    "rotated": False,
                    "trimmed": False,
                    "spriteSourceSize": {"x": 0, "y": 0, "w": CELL_W, "h": CELL_H},
                    "sourceSize": {"w": CELL_W, "h": CELL_H},
                    "duration": 160,
                }
                index += 1
            tags.append(
                {
                    "name": f"{row_name}.{anim}",
                    "from": row * TOTAL + start,
                    "to": row * TOTAL + index - 1,
                    "direction": "forward",
                }
            )

    emit("base", 0, draw_base)
    for i, coat in enumerate(COATS):
        emit(
            f"breed.{coat}", 1 + i,
            lambda d, a, f, c=coat: draw_coat(d, c, a, f),
        )
    for i, prop in enumerate(PROPS):
        emit(
            f"prop.{prop}", 1 + len(COATS) + i,
            lambda d, a, f, o=prop: draw_prop(d, o, a, f),
        )

    OUT.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / "cats.png")
    (OUT / "cats.json").write_text(
        json.dumps(
            {
                "frames": frames,
                "meta": {
                    "app": "scripts/gen-cats.py",
                    "version": "1",
                    "image": "cats.png",
                    "format": "RGBA8888",
                    "size": {"w": sheet.width, "h": sheet.height},
                    "scale": "1",
                    "frameTags": tags,
                },
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"{sheet.width}x{sheet.height}, {len(frames)} frames, {len(tags)} tags")


if __name__ == "__main__":
    build()
