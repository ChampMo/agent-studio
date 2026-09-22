/**
 * Copy the artist's delivery into `apps/desktop/public/art/`, under the names
 * the app asks for.
 *
 * The art arrives organised the way it was drawn — `Cat/Cat-3/Face-fat.png`,
 * `Tools/Toolbox/Toolbox-2.png` — and the app asks for it by what a thing *is*
 * — `art/cats/face/bombay-fat.png`, `art/tools/toolbox/open.png`. Those two
 * namings should not have to be the same, and neither should have to bend to
 * the other: the artist keeps folders that make sense at the drawing board, and
 * the catalogue keeps names that make sense in `avatar_config` and in the UI.
 *
 * This file is the one place the two meet. It is a script rather than a build
 * step because the delivery is occasional and manual — the art is hand-drawn
 * and arrives a folder at a time — and because a copy you can read afterwards
 * is easier to check than a transform that happens invisibly.
 *
 *   node scripts/import-art.mjs "C:\\Users\\sones\\Downloads\\Agentstudio"
 *
 * It reports every file it did not find rather than failing on the first, so a
 * partial delivery imports what it has and names what is still missing. The cat
 * props are exactly that case today: the slot exists, the drawings do not yet.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "apps/desktop/public/art");

/** Cat-N as the artist numbered them -> the catalogue value for that look. */
const BREEDS = {
  "Cat-1": "marmalade", // orange tabby
  "Cat-2": "siamese", // cream with a dark mask
  "Cat-3": "bombay", // black
  "Cat-4": "tuxedo", // grey and white
};

/** The two the artist drew, under the catalogue's names for them. */
const SIZES = { "Face-normal": "normal", "Face-fat": "fat" };

//: Which numbered accessory is which value in `AVATAR_SLOTS`, by the colour
//: it was drawn in. Nine bows, two caps and five pairs of ear bows all sit on
//: top of the head and so share one slot; the seven pairs of glasses sit on
//: the eyes and have their own.
const HEADWEAR = {
  1: "bow_red",
  2: "bow_amber",
  3: "bow_green",
  4: "bow_jade",
  5: "bow_rose",
  6: "bow_violet",
  7: "bow_orchid",
  8: "bow_blue",
  9: "bow_pink",
  10: "cap_tan",
  11: "cap_brown",
  19: "ears_blue",
  20: "ears_violet",
  21: "ears_rose",
  22: "ears_brown",
  23: "ears_amber",
};

const GLASSES = {
  12: "blue",
  13: "red",
  14: "amber",
  15: "green",
  16: "teal",
  17: "brown",
  18: "pink",
};

const COLLARS = ["blue", "green", "pink", "red"];

/**
 * A tool's frames, in the order they play.
 *
 * Named by position rather than by the artist's filename so the renderer can
 * ask for frame `n` without knowing that the dish has three and the NAS has
 * two. `toolbox` is the exception and keeps words, because its two drawings are
 * two *states* — shut and open — not two frames of one loop, and the wrench
 * only makes sense over the open one.
 */
const TOOLS = {
  computer: ["Computer/Case-1.png", "Computer/Case-2.png"],
  dish: ["Dish/Dish-1.png", "Dish/Dish-2.png", "Dish/Dish-3.png"],
  files: ["Files/Nas-1.png", "Files/Nas-2.png"],
  papers: [
    "Papers/Paper-1.png",
    "Papers/Paper-2.png",
    "Papers/Paper-3.png",
    "Papers/Paper-4.png",
  ],
  phone: ["Phone/Phone-1.png", "Phone/Phone-2.png", "Phone/Phone-3.png"],
};

/** What an agent throws, grouped by the moment that makes it fly. */
const THROWS = {
  request: { bell: "Agent-request/throw-bell.png", paw: "Agent-request/throw-paw.png" },
  assign: {
    clipboard: "Assign/throw-clipboard.png",
    folder: "Assign/throw-folder.png",
    mouse: "Assign/throw-mouse.png",
    scroll: "Assign/throw-scroll.png",
  },
  done: { bird: "Done/throw-bird.png", fish: "Done/throw-fish.png" },
  failed: {
    "fish-bone": "Failed/throw-fish_bone.png",
    "tin-empty": "Failed/throw-tin_empty.png",
  },
  message: { note: "Send_message/throw-note.png", plane: "Send_message/throw-plane.png" },
};

/** Room pieces, named for what they are rather than for their number. */
const DECOR = {
  "roomasset-1.png": "cooler.png",
  "roomasset-2.png": "shelf.png",
  "roomasset-3.png": "bookcase.png",
  "roomasset-4.png": "plant.png",
  "roomasset-5.png": "window.png",
};

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/import-art.mjs <delivery folder>");
  process.exit(2);
}
if (!existsSync(src)) {
  console.error(`no such folder: ${src}`);
  process.exit(2);
}

const missing = [];
let copied = 0;

function take(from, to) {
  const a = join(src, from);
  const b = join(DEST, to);
  if (!existsSync(a)) {
    missing.push(from);
    return;
  }
  mkdirSync(dirname(b), { recursive: true });
  copyFileSync(a, b);
  copied += 1;
}

// Start from empty, so a drawing the artist deleted does not linger here and
// go on being drawn by an app that has no idea it was withdrawn. The
// subfolders only: `README.md` beside them is the contract the artist draws
// to, and it is not something a delivery replaces.
if (existsSync(DEST)) {
  for (const entry of readdirSync(DEST, { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(join(DEST, entry.name), { recursive: true, force: true });
  }
}

for (const [folder, breed] of Object.entries(BREEDS)) {
  for (const [file, size] of Object.entries(SIZES)) {
    take(`Cat/${folder}/${file}.png`, `cats/face/${breed}-${size}.png`);
  }
  // Per breed, because that is how they were drawn, even though today all four
  // pairs are within a pixel of each other. Following the folders costs
  // nothing and leaves room for a cat whose eyes are its own.
  take(`Cat/${folder}/Eye-open.png`, `cats/eyes/${breed}-open.png`);
  take(`Cat/${folder}/Eye-close.png`, `cats/eyes/${breed}-close.png`);
}

// One mouth for every cat: the artist drew it once, in its own folder.
take("Cat/mouth/Mouth-close.png", "cats/mouth/close.png");
take("Cat/mouth/Mouth-open.png", "cats/mouth/open.png");

for (const colour of COLLARS) {
  take(`Cat/Collar/Collar-${colour}.png`, `cats/collar/${colour}.png`);
}

// The accessories arrived numbered rather than named, so the number is the
// only thing that identifies one and the table has to carry it. Two folders
// because they are two slots: what is on the head, and what is on the eyes.
// They do not collide — glasses share no pixels with a cap or the ear bows —
// which is the whole reason a cat can wear one of each.
for (const [n, value] of Object.entries(HEADWEAR)) {
  take(`Accessory/Asset-${n}.png`, `cats/headwear/${value}.png`);
}
for (const [n, colour] of Object.entries(GLASSES)) {
  take(`Accessory/Asset-${n}.png`, `cats/glasses/${colour}.png`);
}

take("Room/Room-bg.png", "room/bg.png");
take("Room/Desk.png", "room/desk.png");
// From `cut/`, not `Room/`: the pieces were drawn in place on a picture of
// the room, and `prepare-art.py` crops each to its own ink so the app can
// place it by its feet.
for (const [from, to] of Object.entries(DECOR)) take(`cut/${from}`, `room/${to}`);

for (const [tool, frames] of Object.entries(TOOLS)) {
  frames.forEach((frame, i) => take(`Tools/${frame}`, `tools/${tool}/${i + 1}.png`));
}
take("Tools/Computer/Moniter.png", "tools/computer/monitor.png");
take("Tools/Toolbox/Toolbox-1.png", "tools/toolbox/shut.png");
take("Tools/Toolbox/Toolbox-2.png", "tools/toolbox/open.png");
take("Tools/Toolbox/wrench.png", "tools/toolbox/wrench.png");

for (const [group, items] of Object.entries(THROWS)) {
  for (const [name, from] of Object.entries(items)) {
    take(`Throw/${from}`, `throw/${group}/${name}.png`);
  }
}

for (let i = 1; i <= 4; i += 1) take(`Loading/Loading-${i}.png`, `loading/${i}.png`);

take("Drop/drop-doc.png", "drop/doc.png");
// The other three arrive as screenshots of an icon picker rather than as
// icons, so `scripts/prepare-art.py` lifts the chosen glyph out of each one
// first and leaves the result beside them.
for (const name of ["code", "image", "stamp"]) {
  take(`cut/${name}.png`, `drop/${name}.png`);
}

const seen = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else {
      const digest = createHash("sha256").update(readFileSync(p)).digest("hex");
      const rel = p.slice(DEST.length + 1).replace(/\\/g, "/");
      seen.set(rel, { digest, bytes: statSync(p).size });
    }
  }
}
if (existsSync(DEST)) walk(DEST);

console.log(`imported ${copied} file(s) into apps/desktop/public/art`);
if (missing.length) {
  console.log(`\nnot in the delivery (${missing.length}):`);
  for (const m of missing) console.log(`  ${m}`);
}

// Two names for one drawing is worth knowing about: it is either the artist
// reusing a piece on purpose, or a mapping above pointing twice at the same
// file by mistake.
const byDigest = new Map();
for (const [rel, { digest }] of seen) {
  byDigest.set(digest, [...(byDigest.get(digest) ?? []), rel]);
}
const shared = [...byDigest.values()].filter((paths) => paths.length > 1);
if (shared.length) {
  console.log("\nidentical drawings under more than one name:");
  for (const paths of shared) console.log(`  ${paths.join("  ==  ")}`);
}
