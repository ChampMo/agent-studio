"""Make the delivery importable: cut the icons out, trim the decor down.

Two things in the delivered folder are not quite files the app can use, and
this fixes both into `<delivery>/cut/`, beside the originals, which is where
`import-art.mjs` looks. Nothing is written over the artist's files.

**Three "icons" are screenshots.** `drop.code.png`, `drop.image.png` and
`throw.stamp.png` are 1000-1400px captures of an Iconify browser, each showing
a grid of candidates with one selected and drawn large in a preview pane on
the right. What was handed over was *which* icon to use, not a file to ship.
The glyph is picked out of the pane by being **bright and neutral** — the
pane's background is a dark transparency checkerboard, the chrome round it is
blue, the icon near-white — and written at 50x50 with transparency like every
other icon in the set. A scrollbar at the panel edge is kept out by the window
rather than by cleverness: the first attempt caught one and produced an icon
with a stray bar down its right side.

**The decor was drawn in place.** `roomasset-1..5.png` are 100x100 canvases
with the piece sitting wherever it belonged on the delivered room drawing — the
window in the top-right corner, the bookcase against the left wall. The room is
drawn by the app now, so each piece has to stand on its own: it is cropped to
its ink plus a pixel, and the app places it by its own feet.

    python scripts/prepare-art.py "C:\\Users\\sones\\Downloads\\Agentstudio"
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

#: The preview pane in each screenshot, and what to call the glyph in it.
#:
#: Read off the images and re-checked on every run: a window that no longer
#: lands on a glyph fails loudly rather than writing an empty file. They differ
#: per screenshot because the pane sits in a different place in each.
SHOTS = (
    ("drop.code.png", "code.png", (1248, 473, 1401, 650)),
    ("drop.image.png", "image.png", (849, 431, 1008, 592)),
    ("throw.stamp.png", "stamp.png", (865, 483, 1000, 645)),
)

#: The decor pieces, by the artist's numbering.
DECOR = tuple(f"roomasset-{n}.png" for n in range(1, 6))

#: Bright enough to be the glyph, and grey enough not to be the blue chrome.
BRIGHT = 140
NEUTRAL = 18

#: Flat, because the source glyph is monochrome anyway and sampling its own
#: greys down to 50px only muddies the edges.
INK = (236, 239, 244, 255)

ICON_SIZE = 50


def cut_icon(source: Path, window: tuple[int, int, int, int]) -> Image.Image:
    region = Image.open(source).convert("RGB").crop(window)
    pixels = region.load()
    mask = Image.new("L", region.size, 0)
    painting = mask.load()

    for y in range(region.height):
        for x in range(region.width):
            r, g, b = pixels[x, y]
            lum = (r * 299 + g * 587 + b * 114) // 1000
            if lum > BRIGHT and max(r, g, b) - min(r, g, b) < NEUTRAL:
                painting[x, y] = 255

    box = mask.getbbox()
    if box is None:
        raise SystemExit(f"{source.name}: nothing bright in the window - has the layout moved?")

    left, top, right, bottom = box
    width, height = right - left, bottom - top
    # A glyph filling almost the whole window usually means the window has
    # slipped off the pane and is taking chrome with it.
    if width > region.width * 0.98 or height > region.height * 0.98:
        raise SystemExit(f"{source.name}: the bright area fills the window - check it")

    solid = Image.new("RGBA", region.size, INK)
    solid.putalpha(mask)
    glyph = solid.crop(box)

    # Squared before scaling, so a wide glyph and a tall one come out at the
    # same weight rather than one filling the tile and the other floating in it.
    side = max(width, height)
    pad = max(2, round(side * 0.08))
    canvas = Image.new("RGBA", (side + pad * 2,) * 2, (0, 0, 0, 0))
    canvas.alpha_composite(
        glyph, ((canvas.width - width) // 2, (canvas.height - height) // 2)
    )
    return canvas.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)


def trim(source: Path) -> Image.Image:
    """The piece alone: its ink, one transparent pixel of margin, nothing else."""
    image = Image.open(source).convert("RGBA")
    box = image.getchannel("A").getbbox()
    if box is None:
        raise SystemExit(f"{source.name}: the picture is empty")
    left, top, right, bottom = box
    return image.crop(
        (max(0, left - 1), max(0, top - 1), min(image.width, right + 1), min(image.height, bottom + 1))
    )


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: python scripts/prepare-art.py <delivery folder>")
    src = Path(sys.argv[1])
    if not src.is_dir():
        raise SystemExit(f"no such folder: {src}")

    dest = src / "cut"
    dest.mkdir(exist_ok=True)

    for name, out, window in SHOTS:
        path = src / name
        if not path.exists():
            raise SystemExit(f"missing: {name}")
        cut_icon(path, window).save(dest / out)
        print(f"{name}: -> cut/{out} ({ICON_SIZE}x{ICON_SIZE})")

    for name in DECOR:
        path = src / "Room" / name
        if not path.exists():
            print(f"missing: Room/{name}")
            continue
        piece = trim(path)
        piece.save(dest / name)
        print(f"Room/{name}: -> cut/{name} ({piece.width}x{piece.height})")


if __name__ == "__main__":
    main()
