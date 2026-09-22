/**
 * Which files a cat is drawn from, and which of them exist.
 *
 * A cat is **four layers on one 100x100 canvas**, drawn to share an origin, so
 * compositing them is stacking with no offset arithmetic anywhere:
 *
 *   face   `cats/face/<breed>-<size>.png`   the cat itself, one drawing per
 *                                           breed and size (8 files)
 *   eyes   `cats/eyes/<breed>-<open|close>.png`
 *                                           two frames, and they are genuinely
 *                                           per breed — marmalade's are black,
 *                                           siamese's blue, bombay's gold
 *   mouth  `cats/mouth/<close|open>.png`    two frames, **one pair shared by
 *                                           every cat**, drawn once
 *   collar `cats/collar/<colour>.png`       four colours, same bell on each
 *   head   `cats/headwear/<value>.png`      a bow, a cap or a pair of ear
 *                                           bows — one slot, because all
 *                                           three want the top of the head
 *   specs  `cats/glasses/<colour>.png`      seven colours, over the eyes
 *
 * Eyes and mouth are frames rather than slots because neither is a choice
 * anybody makes: the eyes blink and the mouth moves while its agent is
 * speaking. What the catalogue offers is breed, size, collar, headwear and
 * glasses.
 *
 * **Headwear and glasses are two slots because the drawings do not collide.**
 * Glasses share zero pixels with the cap and zero with the ear bows, so a cat
 * wears one of each; everything on top of the head collides with everything
 * else up there, so those share a slot. The slots are named for the place on
 * the cat, because the place is what decides what can be worn at once.
 *
 * **A frame pair is all or nothing.** A missing collar drops the collar and
 * nothing else, but half a mouth is worse than no mouth: with only `open.png`
 * on disk the cat sits permanently open-mouthed, which reads as *this agent is
 * talking* when nothing on the log said so (§1). Single drawings are dropped
 * one at a time; pairs are dropped together.
 *
 * **A file that is not there is an answer, not a failure.** A cat with no face
 * drawing at all falls through to the sprite composite in `actor.ts` and
 * `Portrait.tsx`. That is not hypothetical: `missions.roster_snapshot` is
 * deliberately never migrated, so replaying an old run hands this module
 * breeds and sizes that no longer exist, and it still has to draw somebody
 * (§5.1, §8).
 *
 * **Existence is asked, not declared.** A manifest listing what has been drawn
 * would be a second place for the truth to live, and the one that goes stale
 * is the list rather than the folder (§2.1). Every path in the catalogue is
 * requested once at startup and the answer kept for the life of the window.
 * Both renderers read the same answers, so the cat at the desk and the cat in
 * the transcript cannot be composed from different files.
 */
import { fetchImage } from "./artFetch";
import { BREEDS, COLLARS, GLASSES, HEADWEAR, SIZES } from "./palette";

const CATS = "/art/cats";

/** The size every cat is drawn at, and what a missing size falls back to. */
const DEFAULT_SIZE = "normal";

/** Shared by all four cats: the artist drew it once, in its own folder. */
const MOUTH = [`${CATS}/mouth/close.png`, `${CATS}/mouth/open.png`];

export interface CatArt {
  /** The cat. Null when nothing has been drawn for it — composite instead. */
  face: string | null;
  /** `[open, close]`, resting frame first. Empty when the pair is incomplete. */
  eyes: string[];
  /** `[close, open]`, resting frame first. Empty when the pair is incomplete. */
  mouth: string[];
  collar: string | null;
  headwear: string | null;
  glasses: string | null;
  /**
   * Whether the face still has to be squashed to show the size.
   *
   * Both sizes are real drawings, so normally this is false and the art does
   * the work. It matters while a delivery is partial: if only `<breed>-normal`
   * has landed, the fat cat has to be made to look fatter or the size slot is
   * a control that claims to do something and does not (§1.1). Squashing a
   * drawing that *was* made for the size would make the same cat fat twice.
   */
  scaled: boolean;
}

export interface CatPaths {
  faceCandidates: string[];
  eyes: string[];
  mouth: string[];
  collar: string | null;
  headwear: string | null;
  glasses: string | null;
}

/**
 * One avatar's slots, resolved against the catalogue.
 *
 * Taken as an object rather than as five strings in a row: they are all
 * strings, so a pair swapped at a call site would be silently wrong art
 * rather than a type error. `Look["keys"]` is exactly this shape.
 */
export interface CatKeys {
  breed: string;
  size: string;
  headwear: string;
  glasses: string;
  collar: string;
}

function facePaths(breed: string, size: string): string[] {
  const exact = `${CATS}/face/${breed}-${size}.png`;
  const plain = `${CATS}/face/${breed}-${DEFAULT_SIZE}.png`;
  return exact === plain ? [plain] : [exact, plain];
}

/** Every file the catalogue could ask for. What startup asks about. */
function allPaths(): string[] {
  const paths = new Set<string>(MOUTH);
  for (const breed of Object.keys(BREEDS)) {
    for (const size of Object.keys(SIZES)) {
      for (const path of facePaths(breed, size)) paths.add(path);
    }
    paths.add(`${CATS}/eyes/${breed}-open.png`);
    paths.add(`${CATS}/eyes/${breed}-close.png`);
  }
  for (const collar of COLLARS) {
    if (collar !== "none") paths.add(`${CATS}/collar/${collar}.png`);
  }
  for (const value of HEADWEAR) {
    if (value !== "none") paths.add(`${CATS}/headwear/${value}.png`);
  }
  for (const colour of GLASSES) {
    if (colour !== "none") paths.add(`${CATS}/glasses/${colour}.png`);
  }
  return [...paths];
}

const there = new Map<string, boolean>();
//: The drawings that answered, kept so a renderer can build its texture from
//: the very bytes the probe saw rather than fetching the path again.
const images = new Map<string, HTMLImageElement>();
let asking: Promise<void> | null = null;
let answered = false;

async function ask(path: string): Promise<void> {
  // A missing file resolves null and stays quiet: an error logged per undrawn
  // file would bury the ones that matter. It is also how a *missing* file
  // reads in dev, where the server answers every unknown path with the app's
  // own HTML — that fails to decode, which is the same answer by a different
  // route.
  const image = await fetchImage(path);
  there.set(path, image !== null);
  if (image) images.set(path, image);
}

/** Ask about every file in the catalogue. Resolves when all have answered. */
export function loadArt(): Promise<void> {
  if (asking) return asking;
  asking = Promise.all(allPaths().map(ask)).then(() => {
    answered = true;
  });
  return asking;
}

/**
 * Whether every answer is in. Before this, nothing should draw a cat.
 *
 * A flag rather than `there.size > 0`, which is what this was and which is
 * true the moment the **first** probe lands. Both renderers read this as "all
 * answers are in" and both carry a comment saying that compositing early would
 * mean visibly replacing the cat a moment later — so the check was quietly
 * promising the one thing it could not deliver. It survived while a cat was
 * one file and four probes resolved in a batch; four layers across four breeds
 * gives it far more chances to be caught mid-map.
 */
export function artReady(): boolean {
  return answered;
}

/** Every path that exists, for a renderer that needs to load them itself. */
export function drawnPaths(): string[] {
  return [...there].filter(([, ok]) => ok).map(([path]) => path);
}

/** The loaded drawing at a path, for a renderer to make its own texture from. */
export function imageFor(path: string): HTMLImageElement | undefined {
  return images.get(path);
}

/**
 * The files this avatar *could* be drawn from, before anything is known about
 * which of them exist. Pure, so the naming rule can be tested on its own.
 */
export function pathsFor(keys: CatKeys): CatPaths {
  const worn = (folder: string, value: string) =>
    value === "none" ? null : `${CATS}/${folder}/${value}.png`;
  return {
    faceCandidates: facePaths(keys.breed, keys.size),
    // Resting frame first, so a renderer that wants a still cat can take
    // index 0 and be right without knowing which way round the pair is.
    eyes: [`${CATS}/eyes/${keys.breed}-open.png`, `${CATS}/eyes/${keys.breed}-close.png`],
    mouth: MOUTH,
    collar: worn("collar", keys.collar),
    headwear: worn("headwear", keys.headwear),
    glasses: worn("glasses", keys.glasses),
  };
}

/**
 * Which of those files to actually draw.
 *
 * Single drawings are dropped one at a time, so a cat whose collar exists and
 * whose glasses do not wears the collar rather than losing both. Frame pairs
 * are dropped whole — see the note at the top of this file.
 */
export function chooseArt(paths: CatPaths, exists: (path: string) => boolean): CatArt {
  const face = paths.faceCandidates.find(exists) ?? null;
  const last = paths.faceCandidates[paths.faceCandidates.length - 1];
  const whole = (frames: string[]) => (frames.every(exists) ? frames : []);
  return {
    face,
    eyes: whole(paths.eyes),
    mouth: whole(paths.mouth),
    collar: paths.collar && exists(paths.collar) ? paths.collar : null,
    headwear: paths.headwear && exists(paths.headwear) ? paths.headwear : null,
    glasses: paths.glasses && exists(paths.glasses) ? paths.glasses : null,
    // The last candidate is always the default-size drawing, so the face was
    // drawn for this size exactly when it is not that one.
    scaled: face !== null && face === last,
  };
}

/**
 * What to draw for this avatar, against the files this window has asked about.
 *
 * `face: null` means nothing has been drawn for this cat and the caller should
 * composite the sprite layers instead.
 */
export function artFor(keys: CatKeys): CatArt {
  return chooseArt(pathsFor(keys), (path) => there.get(path) === true);
}

/**
 * The layers to paint, in order, for a cat that is not animating.
 *
 * One list so the two renderers cannot disagree about paint order, which the
 * delivered ink boxes make load-bearing: the eyes at y 45-50 and the mouth at
 * y 49-69 overlap, and the collar at y 75-85 sits below the face's own bottom
 * edge at y 79.
 *
 * Glasses go on last, after the headwear. The only pair that overlaps at all
 * is a head bow against a pair of glasses, at 34 pixels where the bow's
 * ribbon reaches the top of the rim — and a bow is behind the glasses on an
 * actual face, so the rim is what covers the ribbon.
 */
export function restingLayers(art: CatArt): string[] {
  return [
    art.face,
    art.eyes[0],
    art.mouth[0],
    art.collar,
    art.headwear,
    art.glasses,
  ].filter((path): path is string => typeof path === "string");
}
