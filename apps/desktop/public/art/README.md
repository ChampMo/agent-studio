# The drawn art

Everything in here is hand-drawn and arrives as a delivery folder; nothing is
edited in place. `node scripts/import-art.mjs <delivery>` copies it in under the
names the app asks for, after `python scripts/prepare-art.py <delivery>` has
cut the icon screenshots and trimmed the decor. Re-importing replaces every
subfolder here and leaves this file alone.

    cats/face/<breed>-<size>.png      the cat: 4 breeds x 2 sizes
    cats/eyes/<breed>-<open|close>.png two frames, per breed (the eyes differ)
    cats/mouth/<close|open>.png       two frames, one pair shared by every cat
    cats/collar/<colour>.png          blue, green, pink, red
    cats/headwear/<value>.png         on top of the head: a bow, a cap or a
                                      pair of ear bows. One slot, because all
                                      three want the same place
    cats/glasses/<colour>.png         over the eyes, its own slot
    room/desk.png  room/{window,bookcase,shelf,plant,cooler}.png
    tools/<tool>/<n>.png              frame sequences, played in order
    tools/toolbox/{shut,open,wrench}.png
    throw/<moment>/<thing>.png        request, assign, done, failed, message
    loading/1..4.png                  a fish being eaten: the thinking indicator
    drop/{doc,code,image,stamp}.png

The names are the backend's catalogue — `AVATAR_SLOTS` in
`services/agentd/agentd/agents/avatar.py` — and that list is the authority.
Adding a fifth cat is an edit there, a line in `import-art.mjs`, and the files.

**The room is not a picture.** It is drawn by the app (`scene/entities/room.ts`)
so that it follows the theme — a fixed cream room left the dusk theme's
near-white labels unreadable — and so that it is exactly as wide as the seats
need, which a single image cannot be. What is drawn borrows this art's style:
flat fills, ink outlines, a scatter of dots on the walls.

## A cat is four layers on one canvas

Every cat file is 100x100 and shares one origin, so the app stacks them with
no offset arithmetic. That is the rule that makes the whole thing work, and it
is why a prop has to be drawn on a 100x100 canvas *in the place it sits on the
cat*, not cropped to its own ink.

A missing file is an answer, not an error. Each path is asked for once, at
startup, and drawn if it came back:

* no face for a breed — that cat falls back to the layered sprite composite in
  `public/sprites/`, which also draws every run recorded before this art
  existed (`missions.roster_snapshot` is never migrated);
* no `<breed>-fat.png` — the normal drawing is used and squashed, so the size
  slot still visibly does something;
* a missing collar, hat or pair of glasses drops just that one thing;
* **a frame pair is all or nothing.** Half a mouth would leave the cat
  permanently open-mouthed, which reads as "this agent is speaking" when
  nothing on the log said so.

## What a drawing has to be

* **Square, and every layer of a cat the same size.** 100x100 is what the set
  was drawn at.
* **Transparent background.** Behind a cat is the room in the scene and the
  panel in the UI, and those differ per theme.
* **Readable on both grounds.** The app has a light theme and a dark one and
  the same file is used in both. A cat that is nearly white or nearly black
  needs enough outline to keep its shape.
* **An accessory is drawn where it sits, on the same 100x100 canvas**, not
  cropped to itself — the app stacks the layers with no offset arithmetic, so
  the position is in the file. Two accessories may only share a slot if they
  overlap; the app measures nothing at runtime. Glasses share zero pixels
  with the cap and zero with the ear bows, which is why they are their own
  slot, and a head bow covers the ear bows by 220 pixels, which is why those
  share one.
* **Decor stands on its foot.** The room pieces are trimmed to their ink by
  `prepare-art.py`, and the app places each by its *lowest ink pixel* (the
  middle of that row), measured when the file loads — so a bookcase drawn at
  2:1 for the left wall stands on the skirting by its front foot, and a pot
  stands on its centre. Draw a piece against a wall at the room's 2:1 slope;
  draw a free-standing piece upright with a flat base. Nothing below the
  base (a shadow, say): the lowest ink is what touches the floor.
* **A tool is one 50x50 canvas per frame**, every frame of a loop the same
  size with the thing drawn in the same place, because the frames are swapped
  in on one sprite. The desk shows only the tool in use, playing its loop; the
  toolbox shows `open.png` with `wrench.png` floating above it; the computer
  is `1..n` for the case with `monitor.png` standing still beside it.
