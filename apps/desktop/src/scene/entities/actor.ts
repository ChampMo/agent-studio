/**
 * One cat at one desk.
 *
 * M5 said the art would replace `redraw` and not the data path, and this is
 * that swap: three `AnimatedSprite` layers where the primitives were, fed by
 * the same `avatar_config` and the same pose derived from the event stream.
 * `sceneState`, `poses.ts` and the stage did not change.
 *
 * **Drawn artwork where there is some, the tinted layers where there is not.**
 * A cat is a face with a collar, headwear and glasses over it, and
 * `catArt.ts` says which files. The layered version is the fallback, kept and still
 * exercised: a frozen `roster_snapshot` names slots this catalogue no longer
 * has, and it still has to draw as somebody (§5.1, §8). Which of the two is
 * used is the same decision `Portrait.tsx` makes, from the same answers, so
 * the cat at the desk and the cat in the transcript cannot be composed from
 * different drawings (§2.1).
 *
 * **Three layers, tinted** — the fallback. The sheet holds one cat, eight
 * coats and eight outfits; `build` scales and `palette` tints. That is what
 * keeps 5 x 8 x 8 x 8 combinations down to seventeen rows of art — and why the
 * sprites are drawn in white, since a tint multiplies.
 *
 * **A drawn cat is shown whole; the fallback is a portrait.** The delivered
 * cats are a head on a transparent canvas and are drawn exactly as they
 * come, with no frame — the artist asked for the disc to go, and round a
 * drawing that already ends at its own outline it was a frame round nothing.
 * The sprite fallback is a whole standing cat, so that one is still masked
 * to a disc and cropped to the head — the same 32x22 region `Portrait.tsx`
 * cuts, through the same `lookFor` (§2.1).
 *
 * The poses had been carrying some of the meaning: lean toward the desk, a
 * shoulder slump. A head cannot do either, so what they said moves to things
 * that can — the caption word underneath, which was always the part that
 * actually said it, in amber for `waiting`; and the lamp for work. Nothing
 * true is lost: `blocked` is the only pose whose slump was its whole
 * expression, and the backend has never once published it.
 *
 * The desk is the delivered drawing, with the primitive kept behind it for a
 * build with no picture. What is *on* the desk is the tool the agent is
 * using at this moment, off the log (`deskTool.ts`, `props.ts`).
 *
 * Nothing is drawn that is not true (§1.1). A name, a pose word, the task they
 * are on, and the tool they are using right now. No bars, no numbers.
 */
import {
  AnimatedSprite,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";

import type { Actor } from "../bindings/sceneState";
import { shapeFor } from "../animation/poses";
import { lookFor } from "./palette";
import { framesFor } from "./sheet";
import { artFor, artReady } from "./catArt";
import { textureFor } from "./picture";
import { pieceTexture } from "./roomArt";
import { DeskTool } from "./deskTool";
import { PROP_AT } from "./props";
import { roomColours } from "./room";
import { TILE_H, TILE_W } from "../engine/iso";

/** The cell the sheet is drawn at.
 *
 *  There is no whole-number `SCALE` any more. It existed because the cat was
 *  shown at a fixed 2x and pixel art scaled by anything else shears — but a
 *  portrait is sized by its disc, and the disc has to be the same physical
 *  size whatever `build` says about the cat inside it. The shearing is bought
 *  off by `nearest` filtering on the sheet instead, which is what actually
 *  decides how a scaled sprite is sampled. */
const CELL_W = 32;
const CELL_H = 40;

/** How much of the 40px cell is head. The same number `Portrait.tsx` uses, so
 *  the room and the transcript crop at the same line. */
const HEAD_H = 22;
/** The disc's radius in world units, before `build` scales it. */
const FACE_R = 40;
/** The ring drawn round the disc. Thick enough to read at the zoomed-out fit,
 *  which is where the scene spends most of its time. */
const RING_W = 2.5;

/** The order the cat's drawn layers are stacked in. */
type CatLayer = "face" | "eyes" | "mouth" | "collar" | "headwear" | "glasses";
const CAT_LAYERS: readonly CatLayer[] = [
  "face",
  "eyes",
  "mouth",
  "collar",
  "headwear",
  "glasses",
];

/**
 * Blink timing, in seconds.
 *
 * A blink is the one piece of movement here that claims nothing — a cat that
 * blinks is not reporting anything about the run — so it may run on a timer
 * where the mouth may not. It is slow and brief on purpose: at this size a
 * fast or frequent blink reads as flicker.
 */
const BLINK_EVERY = 4.6;
const BLINK_FOR = 0.13;

/** How fast the mouth opens and shuts while its agent is speaking. */
const MOUTH_HZ = 2.5;

/**
 * How big the drawn desk stands.
 *
 * Its ink is 87 pixels wide in the file. The primitive it replaces spanned two
 * tiles; the drawing is given a little less, so two desks a tile apart keep
 * a sliver of floor between them and read as two desks.
 */
const DESK_INK_W = 87;
const DESK_SCALE = (TILE_W * 1.75) / DESK_INK_W;

// The four styles below carry no colour of their own: `paintText` sets each
// from the theme every time the scene draws. A `TextStyle` created once at
// module scope with a literal fill is a label that keeps whichever theme
// happened to be on when the module first loaded.
/** Text is rasterised once at its font size and then scaled by the camera,
 *  so at 3x it was three-times-blurred. Drawn at this many pixels per unit
 *  instead, which covers the automatic fit's ceiling and some zoom on top. */
const TEXT_RESOLUTION = 4;

const LABEL = new TextStyle({
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: 13,
  fontWeight: "600",
});

const CAPTION = new TextStyle({
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
});

const SPEECH = new TextStyle({
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: 11,
  wordWrap: true,
  wordWrapWidth: 190,
  lineHeight: 15,
});

const TASK = new TextStyle({
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: 11,
  wordWrap: true,
  wordWrapWidth: 150,
  align: "center",
});

/** The textures for a frame pair, or none at all if either is missing. */
function frames(paths: string[]): Texture[] {
  const loaded = paths.map(textureFor).filter((t): t is Texture => t !== undefined);
  return loaded.length === paths.length ? loaded : [];
}

export class ActorView extends Container {
  //: Behind everything: the pool of lamplight under a cat that is working.
  private readonly lamp = new Graphics();
  private readonly desk = new Graphics();
  //: The drawn desk. Empty until the picture arrives, at which point the
  //: primitive above stops being drawn and this takes its place.
  private readonly deskArt = new Sprite();
  //: Everything that walks: the cat, its name, its words. The desk, the lamp
  //: and the tool stay at the seat — a cat crossing the room to talk used to
  //: take its desk with it, because the whole view was what moved.
  readonly body = new Container();
  //: The cat: base, then markings, then clothes. Separate sprites so eight
  //: coats and eight outfits cost two rows of art rather than sixty-four.
  private readonly figure = new Container();
  //: The cropped head, inside `figure`, so the mask travels with the bob and
  //: the walk rather than staying behind while the cat moves out of it.
  private readonly face = new Container();
  //: The disc the face is cut to, and the ring drawn on top of its edge.
  private readonly faceMask = new Graphics();
  private readonly ring = new Graphics();
  private readonly layers: AnimatedSprite[] = [];
  //: The drawn cat, one sprite per layer, **named rather than indexed**.
  //:
  //: This was a `Sprite[]` re-pointed by position, which was fine while a cat
  //: was a body plus an ordered bag of overlays. It stops being fine with four
  //: optional layers: a cat wearing no collar and the same cat a moment later
  //: wearing one produce lists of different lengths, so slot 2 would hold the
  //: mouth in one state and the collar in the next — the right drawings at the
  //: wrong depth, which looks like bad art rather than bad reuse.
  //:
  //: Made on first use rather than in the constructor, so an actor that never
  //: gets a drawing costs nothing. They are added in paint order and Pixi
  //: keeps that order, so the eyes and mouth land over the face and the collar
  //: over both — which the delivered ink boxes require, since eyes at y 45-50
  //: and mouth at y 49-69 overlap and the collar at y 75-85 hangs below the
  //: face's own bottom edge.
  private readonly drawn_layers: Partial<Record<CatLayer, Sprite>> = {};
  //: The two frames of each loop, kept so a tick can swap them without
  //: going back through the texture store.
  private eyeFrames: Texture[] = [];
  private mouthFrames: Texture[] = [];
  //: The tool in use, on the near half of the desk. Bare when there is none.
  private readonly tool = new DeskTool();
  //: Kept only so a sheet that arrives late can be drawn without waiting for
  //: the next state change.
  private drawn = false;
  // Not `name`: Container already owns that property, and shadowing it makes
  // ActorView stop type-checking as something the stage can hold.
  private readonly nameLabel = new Text({ text: "", style: LABEL, resolution: TEXT_RESOLUTION });
  private readonly caption = new Text({ text: "", style: CAPTION, resolution: TEXT_RESOLUTION });
  private readonly task = new Text({ text: "", style: TASK, resolution: TEXT_RESOLUTION });
  private readonly bubble = new Graphics();
  private readonly speech = new Text({ text: "", style: SPEECH, resolution: TEXT_RESOLUTION });
  private phase = Math.random() * Math.PI * 2;
  //: Where in its own blink cycle this cat is. Seeded per actor so a room
  //: does not blink in unison, which reads as a glitch rather than as cats.
  private blinkPhase = Math.random() * BLINK_EVERY;
  private state: Actor | null = null;
  /** 0 when standing, otherwise the direction of travel. */
  private walking = 0;

  constructor() {
    super();
    this.face.mask = this.faceMask;
    this.figure.addChild(this.face, this.faceMask, this.ring);
    // The tool after the body: the cat sits at the far edge of the desk and
    // the tool on the near half, so the tool is in front of the cat. It went
    // behind when the body became its own container and was added last, and
    // a toolbox peeking out from under a chin was the result.
    this.addChild(this.lamp, this.desk, this.deskArt, this.body, this.tool);
    this.body.addChild(
      this.figure,
      this.nameLabel,
      this.caption,
      this.task,
      this.bubble,
      this.speech,
    );
    this.nameLabel.anchor.set(0.5, 1);
    this.caption.anchor.set(0.5, 0);
    this.task.anchor.set(0.5, 0);
    this.speech.anchor.set(0.5, 1);
    this.tool.position.set(PROP_AT.x, PROP_AT.y);
  }

  update(actor: Actor): void {
    const changed =
      this.state?.pose !== actor.pose ||
      this.state?.avatar !== actor.avatar ||
      this.state?.name !== actor.name;
    const toolChanged = this.state?.activeTool !== actor.activeTool;
    this.state = actor;

    this.nameLabel.text = (actor.isLeader ? "★ " : "") + actor.name;
    this.caption.text = shapeFor(actor.pose).caption;
    this.task.text = actor.task ?? "";
    this.say(actor.says);
    if (changed) this.redraw();
    else if (toolChanged) this.tool.show(actor.activeTool, roomColours());
  }

  /**
   * Which way this character is travelling, set by the stage each frame.
   *
   * The walk is not decided here and not decided there either: the stage is
   * closing a gap between two positions the derivation chose. This only affects
   * how it looks while that happens.
   */
  setWalking(direction: number): void {
    this.walking = direction;
  }

  /** Called every frame by the stage: the idle bob, and the gait when moving. */
  tick(elapsed: number): void {
    if (!this.state) return;
    const shape = shapeFor(this.state.pose);
    if (this.walking !== 0) {
      // A bob and a tilt while crossing the room, so it reads as travelling
      // rather than sliding.
      //
      // No mirroring any more. `scale.x = -1` used to flip the whole figure so
      // a cat walking left faced left, which worked because the walk row is
      // drawn front-on — a known compromise, recorded as an open item. A face
      // has no direction to flip, so the compromise is simply gone.
      this.figure.y = -Math.abs(Math.sin(elapsed * 9)) * 3.5;
      this.figure.rotation = Math.sin(elapsed * 9) * 0.05;
    } else {
      this.figure.y = Math.sin(elapsed * 2.4 + this.phase) * shape.bob;
      this.figure.rotation = 0;
    }
    this.blink(elapsed);
    this.talk(elapsed);
    this.tool.tick(elapsed);
  }

  /**
   * Shut the eyes for a moment, every few seconds, out of step with the room.
   *
   * A blink is permissible movement because it claims nothing: no reader
   * learns anything from it and it cannot be wrong about the run. That is the
   * whole test this had to pass, and it is the reason the mouth below is
   * governed quite differently (§1.1).
   */
  private blink(elapsed: number): void {
    const eyes = this.drawn_layers.eyes;
    if (!eyes || this.eyeFrames.length < 2) return;
    const into = (elapsed + this.blinkPhase) % BLINK_EVERY;
    eyes.texture = into < BLINK_FOR ? this.eyeFrames[1]! : this.eyeFrames[0]!;
  }

  /**
   * Move the mouth **only while this agent is actually saying something.**
   *
   * A moving mouth is the screen claiming somebody is speaking right now, so
   * it is driven by the derivation rather than by a timer. `says` is what
   * `scene/bindings/talk.ts` put there, and that already refuses to speak
   * while replaying and already drops anything older than its window — so the
   * mouth inherits both refusals instead of getting a second opinion (§2.1).
   *
   * Without that gate this would be a room of cats mouthing over a record from
   * last week, which is the same family of bug as the chime that fired thirty
   * times on reconnect, the caption describing a round that ended hours ago,
   * and the `waiting` pose that outlived its own question. It closes the
   * moment `says` goes away, including on `mission.ended`, because the
   * derivation clears it there.
   */
  private talk(elapsed: number): void {
    const mouth = this.drawn_layers.mouth;
    if (!mouth || this.mouthFrames.length < 2) return;
    const speaking = Boolean(this.state?.says);
    const open = speaking && Math.sin(elapsed * MOUTH_HZ * Math.PI * 2) > 0;
    mouth.texture = open ? this.mouthFrames[1]! : this.mouthFrames[0]!;
  }

  /**
   * The speech bubble: what this character actually said, shortened by the
   * derivation and never rewritten here (§1.1).
   */
  private say(text: string | null): void {
    const paint = roomColours();
    this.bubble.clear();
    this.speech.text = text ?? "";
    this.speech.visible = text !== null;
    if (text === null) return;

    const w = this.speech.width + 16;
    const h = this.speech.height + 12;
    const top = this.speech.y - h;
    this.bubble
      .roundRect(-w / 2, top, w, h, 8)
      .fill({ color: paint.bubble })
      // The tail, pointing down at whoever is speaking.
      .moveTo(-5, top + h)
      .lineTo(5, top + h)
      .lineTo(0, top + h + 7)
      .closePath()
      .fill({ color: paint.bubble });
  }

  private redraw(): void {
    if (!this.state) return;
    const look = lookFor(this.state.avatar);

    // ---- desk: an iso diamond with a front face ----
    const paint = roomColours();

    // ---- the lamp ----
    //
    // On only while this cat is actually doing something. It is drawn as a few
    // stepped ellipses rather than a smooth gradient: this is a pixel-art
    // scene, and a soft blur in the middle of it reads as a different picture.
    //
    // It says nothing a caption does not already say — it is the same `pose`,
    // shown a second way — so it can be missed without anything being lost,
    // which is the only kind of decoration this scene allows (§1.1).
    this.lamp.clear();
    const busy =
      this.state.pose === "working" || this.state.pose === "thinking";
    if (busy) {
      for (let ring = 3; ring >= 1; ring -= 1) {
        this.lamp
          .ellipse(
            0,
            TILE_H * 1.05,
            TILE_W * (0.5 + ring * 0.28),
            TILE_H * (0.5 + ring * 0.28),
          )
          .fill({ color: paint.lamp, alpha: 0.05 });
      }
    }

    this.nameLabel.style.fill = paint.label;
    this.caption.style.fill = paint.caption;
    this.task.style.fill = paint.task;
    this.speech.style.fill = paint.bubbleText;

    this.desk.clear();
    const deskTexture = pieceTexture("desk");
    if (deskTexture) {
      this.deskArt.texture = deskTexture;
      this.deskArt.visible = true;
      // The drawn desk's top is a diamond whose centre sits 31% of the way
      // down the picture. Anchoring there and placing it at the tile's centre
      // puts the drawn top exactly where the primitive's top was, so nothing
      // that stands on the desk has to move.
      this.deskArt.anchor.set(0.495, 0.31);
      this.deskArt.scale.set(DESK_SCALE);
      this.deskArt.position.set(0, TILE_H);
    } else {
      this.deskArt.visible = false;
      this.desk
        .moveTo(0, 0)
        .lineTo(TILE_W, TILE_H)
        .lineTo(0, TILE_H * 2)
        .lineTo(-TILE_W, TILE_H)
        .closePath()
        .fill({ color: paint.deskTop })
        .stroke({ color: paint.deskSide, width: 1 });
      this.desk
        .moveTo(-TILE_W, TILE_H)
        .lineTo(0, TILE_H * 2)
        .lineTo(0, TILE_H * 2 + 10)
        .lineTo(-TILE_W, TILE_H + 10)
        .closePath()
        .fill({ color: paint.deskSide });
    }

    // ---- what is on the desk: the tool in use right now, or nothing ----
    this.tool.show(this.state.activeTool, paint);

    // ---- the cat ----
    this.paint(look);
  }

  /**
   * Build or re-point the three sprite layers.
   *
   * Called on a state change and again when the sheet finishes loading, since
   * a mission that is paused or finished produces no further changes and would
   * otherwise sit empty over a sheet that arrived a moment too late — the same
   * failure the renderer already had once, when it only drew on change.
   */
  private paint(look: ReturnType<typeof lookFor>): void {
    if (!this.state) return;
    // Always the resting frame. A portrait is a face, not a performance: the
    // pose used to be read off the body's lean and slump, and what is left of
    // it here is the lamp and the word underneath. Animating the head through
    // `working` frames would be movement that says nothing the caption does
    // not already say, on the one element the eye returns to.
    const pose = "idle";
    // Fur comes from the stylesheet where the theme names it, and from the
    // table only where it does not — see `palette.ts`.
    const paint = roomColours();
    const fur = look.breed.token ? paint[look.breed.token] : look.breed.fur;
    const rows = [
      { layer: "base", tint: fur },
      { layer: `breed.${look.breed.layer}`, tint: look.breed.marking },
      // No accessory row. The sheet is what draws a cat this build has no
      // picture of, and the hats and glasses exist only as drawings — so a
      // composited cat wears nothing, the same as it wears no collar, rather
      // than something improvised from a row meant for the old `prop` slot
      // (§8).
    ];

    // The disc is the same size for everybody. It is the frame, not the cat —
    // a fat cat in a bigger circle would be saying two things at once, and the
    // one the catalogue actually offers is how round the cat is.
    const radius = FACE_R;

    if (!artReady()) {
      // Nothing has answered yet, so whether this cat has been drawn is not
      // yet known. Compositing the fallback now would mean visibly replacing
      // it a moment later with a different cat.
      this.drawn = false;
      return;
    }

    const art = artFor(look.keys);
    const wanted: Partial<Record<CatLayer, Texture | undefined>> = art.face
      ? {
          face: textureFor(art.face),
          // Resting frames here. `tick` swaps them; paint decides what a
          // still cat looks like.
          eyes: art.eyes[0] ? textureFor(art.eyes[0]) : undefined,
          mouth: art.mouth[0] ? textureFor(art.mouth[0]) : undefined,
          collar: art.collar ? textureFor(art.collar) : undefined,
          headwear: art.headwear ? textureFor(art.headwear) : undefined,
          glasses: art.glasses ? textureFor(art.glasses) : undefined,
        }
      : {};

    if (wanted.face) {
      this.eyeFrames = frames(art.eyes);
      this.mouthFrames = frames(art.mouth);
      for (const layer of CAT_LAYERS) {
        const texture = wanted[layer];
        let sprite = this.drawn_layers[layer];
        if (!texture) {
          if (sprite) sprite.visible = false;
          continue;
        }
        if (!sprite) {
          sprite = new Sprite(texture);
          sprite.anchor.set(0.5);
          this.drawn_layers[layer] = sprite;
          this.face.addChild(sprite);
        } else {
          sprite.texture = texture;
        }
        sprite.visible = true;
        // The canvas is sized to the disc's diameter whatever the file's own
        // dimensions turn out to be, so a cat drawn on a bigger canvas than
        // its neighbours does not come out smaller than them.
        const fit = (radius * 2) / Math.max(texture.width, texture.height);
        // The size is in the artwork when it was drawn for this size, and in a
        // squash when it was not — never both, which would make the same cat
        // fat twice. Every layer takes the same one, so a collar stays on the
        // neck it was drawn on.
        sprite.scale.set(
          art.scaled ? fit * look.size.w : fit,
          art.scaled ? fit * look.size.h : fit,
        );
        sprite.position.set(0, 0);
      }
      // The tinted layers keep their textures and are only hidden, so a cat
      // with no drawing beside this one — or a theme change — costs no
      // rebuilding.
      for (const layer of this.layers) layer.visible = false;
    } else {
      for (const sprite of Object.values(this.drawn_layers)) {
        sprite.visible = false;
      }
      this.eyeFrames = [];
      this.mouthFrames = [];

      const sets = rows.map((r) => framesFor(r.layer, pose));
      if (sets.some((f) => f === null)) {
        // No sheet yet. Nothing is drawn rather than something invented, and
        // the next call gets it.
        this.drawn = false;
        return;
      }

      const scale = (radius * 2) / CELL_W;

      rows.forEach((row, index) => {
        const frames = sets[index] as Texture[];
        let sprite = this.layers[index];
        if (!sprite) {
          sprite = new AnimatedSprite(frames);
          sprite.animationSpeed = 0.12;
          // Top-centre: `y = 0` is the top of the cell, so the head occupies
          // 0..HEAD_H and can be lifted into the middle of the disc by one
          // number rather than by arithmetic on the body's height.
          sprite.anchor.set(0.5, 0);
          sprite.play();
          this.layers[index] = sprite;
          this.face.addChild(sprite);
        } else {
          sprite.textures = frames;
          sprite.play();
        }
        sprite.visible = true;
        sprite.tint = row.tint;
        // Not uniform: `size` is a width, and a uniform scale threw it away
        // entirely — the dropdown had five options that all drew the same cat.
        // Height rides along barely changed, which is what keeps the axis
        // readable as "rounder" rather than "bigger".
        sprite.scale.set(scale * look.size.w, scale * look.size.h);
        sprite.position.set(0, -(HEAD_H * scale) / 2);
      });
    }

    // Centre of the head, a little above the desk so the face clears it.
    const cy = TILE_H * 0.3 - radius * 0.15;
    this.face.position.set(0, cy);

    const waiting = this.state.pose === "waiting";
    if (wanted.face) {
      // No disc and no ring round a drawn cat. The disc crops a sprite of a
      // whole standing cat down to its head; these were drawn as a head on a
      // transparent canvas, and a frame round that was a frame round nothing.
      // The ring's one job that was not decoration — amber for `waiting` —
      // moves to the caption below, which is the word it was paired with.
      this.face.mask = null;
      this.faceMask.clear();
      this.ring.clear();
    } else {
      this.face.mask = this.faceMask;
      this.faceMask.clear().circle(0, cy, radius).fill({ color: 0xffffff });
      // The ring. Amber for `waiting`, which is the one status that means
      // the run has stopped on the reader — the same colour, meaning the
      // same thing, as everywhere else in the app. A plain edge otherwise,
      // so the disc has a boundary against the floor rather than bleeding
      // into it.
      this.ring
        .clear()
        .circle(0, cy, radius + RING_W / 2)
        .stroke({
          color: waiting ? paint.attn : paint.deskSide,
          width: waiting ? RING_W * 1.6 : RING_W,
          alpha: waiting ? 1 : 0.7,
        });
    }
    // "It is your turn", on the word that says so — the colour the rest of
    // the app reserves for exactly that, and never on its own (§18.3).
    this.caption.style.fill = waiting ? paint.attn : paint.caption;

    this.drawn = true;

    this.nameLabel.position.set(0, cy - radius - 8);
    // Below the desk's front edge: the tool has the desk top now.
    this.caption.position.set(0, TILE_H * 2 + 4);
    this.task.position.set(0, TILE_H * 2 + 20);
    this.speech.position.set(0, this.nameLabel.y - 20);
    if (this.state.says) this.say(this.state.says);
    void CELL_H;
  }

  /** Redraw the furniture after a theme change. The cat itself is tinted from
   *  `avatar_config`, which does not depend on the theme. */
  repaintRoom(): void {
    if (this.state) this.redraw();
  }

  /** Draw again once the art is in, for a scene that is otherwise still. */
  refresh(): void {
    if (this.drawn || !this.state) return;
    this.paint(lookFor(this.state.avatar));
  }
}
