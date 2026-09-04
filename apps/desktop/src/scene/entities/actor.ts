/**
 * One cat at one desk.
 *
 * M5 said the art would replace `redraw` and not the data path, and this is
 * that swap: three `AnimatedSprite` layers where the primitives were, fed by
 * the same `avatar_config` and the same pose derived from the event stream.
 * `sceneState`, `poses.ts` and the stage did not change.
 *
 * **Three layers, tinted.** The sheet holds one cat, eight coats and eight
 * outfits; `build` scales and `palette` tints. That is what keeps 5 x 8 x 8 x 8
 * combinations down to seventeen rows of art — and why the sprites are drawn in
 * white, since a tint multiplies.
 *
 * The desk stays a primitive for now: it is furniture, it never animates, and
 * drawing it here means one fewer thing to keep registered against the sheet.
 * The props on it come from the agent's real tools (`props.ts`).
 *
 * Nothing is drawn that is not true (§1.1). A name, a pose word, the task they
 * are on, and things on the desk they can actually use. No bars, no numbers.
 */
import {
  AnimatedSprite,
  Container,
  Graphics,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";

import type { Actor } from "../bindings/sceneState";
import { shapeFor } from "../animation/poses";
import { lookFor } from "./palette";
import { framesFor } from "./sheet";
import { propsFor, drawProp } from "./props";
import { roomColours } from "./room";
import { TILE_H, TILE_W } from "../engine/iso";

/** The cell size the sheet is drawn at, and the whole-number factor it is
 *  shown at. Pixel art scaled by anything else shears. */
const CELL_W = 32;
const CELL_H = 40;
const SCALE = 2;

// The four styles below carry no colour of their own: `paintText` sets each
// from the theme every time the scene draws. A `TextStyle` created once at
// module scope with a literal fill is a label that keeps whichever theme
// happened to be on when the module first loaded.
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

export class ActorView extends Container {
  //: Behind everything: the pool of lamplight under a cat that is working.
  private readonly lamp = new Graphics();
  private readonly desk = new Graphics();
  //: The cat: base, then markings, then clothes. Separate sprites so eight
  //: coats and eight outfits cost two rows of art rather than sixty-four.
  private readonly figure = new Container();
  private readonly layers: AnimatedSprite[] = [];
  private readonly props = new Graphics();
  //: Kept only so a sheet that arrives late can be drawn without waiting for
  //: the next state change.
  private drawn = false;
  // Not `name`: Container already owns that property, and shadowing it makes
  // ActorView stop type-checking as something the stage can hold.
  private readonly nameLabel = new Text({ text: "", style: LABEL });
  private readonly caption = new Text({ text: "", style: CAPTION });
  private readonly task = new Text({ text: "", style: TASK });
  private readonly bubble = new Graphics();
  private readonly speech = new Text({ text: "", style: SPEECH });
  private phase = Math.random() * Math.PI * 2;
  private state: Actor | null = null;
  /** 0 when standing, otherwise the direction of travel. */
  private walking = 0;

  constructor() {
    super();
    this.addChild(
      this.lamp,
      this.desk,
      this.props,
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
  }

  update(actor: Actor): void {
    const changed =
      this.state?.pose !== actor.pose ||
      this.state?.avatar !== actor.avatar ||
      this.state?.name !== actor.name;
    this.state = actor;

    this.nameLabel.text = (actor.isLeader ? "★ " : "") + actor.name;
    this.caption.text = shapeFor(actor.pose).caption;
    this.task.text = actor.task ?? "";
    this.say(actor.says);
    if (changed) this.redraw();
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
      // A two-beat gait. Bigger and faster than the idle bob, so crossing the
      // room reads as walking rather than sliding.
      this.figure.y = -Math.abs(Math.sin(elapsed * 9)) * 3.5;
      this.figure.rotation = Math.sin(elapsed * 9) * 0.05;
      this.figure.scale.x = this.walking < 0 ? -1 : 1;
    } else {
      this.figure.y = Math.sin(elapsed * 2.4 + this.phase) * shape.bob;
      this.figure.rotation = 0;
      this.figure.scale.x = 1;
    }
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

    // ---- what is on the desk, from the tools this agent actually carries ----
    //
    // Three slots, filled by a fixed priority. An agent with eleven tools has
    // more prop groups than the desk has room for, and a desk piled with six
    // things says less than one showing the three that set this cat apart.
    // Fixed rather than computed from the team, so the same agent looks the
    // same on every team they are on.
    this.props.clear();
    propsFor(this.state.tools ?? []).forEach((prop, slot) => {
      drawProp(this.props, prop, slot, paint);
    });

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
    const pose = this.state.pose;
    // Fur comes from the stylesheet where the theme names it, and from the
    // table only where it does not — see `palette.ts`.
    const paint = roomColours();
    const fur = look.palette.token
      ? paint[look.palette.token]
      : look.palette.fur;
    const rows = [
      { layer: "base", tint: fur },
      { layer: `coat.${look.keys.coat}`, tint: look.palette.marking },
      { layer: `outfit.${look.keys.outfit}`, tint: look.palette.cloth },
    ];

    const sets = rows.map((r) => framesFor(r.layer, pose));
    if (sets.some((f) => f === null)) {
      // No sheet yet. Nothing is drawn rather than something invented, and the
      // next call gets it.
      this.drawn = false;
      return;
    }

    rows.forEach((row, index) => {
      const frames = sets[index] as Texture[];
      let sprite = this.layers[index];
      if (!sprite) {
        sprite = new AnimatedSprite(frames);
        sprite.animationSpeed = 0.12;
        sprite.anchor.set(0.5, 1);
        sprite.play();
        this.layers[index] = sprite;
        this.figure.addChild(sprite);
      } else {
        sprite.textures = frames;
        sprite.play();
      }
      sprite.tint = row.tint;
      // Integer scale, then the build multiplier on top. `round` keeps the
      // sprite on whole pixels; the multiplier is a proportion, not a stat.
      sprite.scale.set(SCALE * look.build.w, SCALE * look.build.h);
      sprite.position.set(0, TILE_H * 0.9);
    });

    this.drawn = true;

    const height = CELL_H * SCALE * look.build.h;
    const top = TILE_H * 0.9 - height;
    this.nameLabel.position.set(0, top - 6);
    this.caption.position.set(0, TILE_H * 0.9 + 6);
    this.task.position.set(0, TILE_H * 0.9 + 22);
    this.speech.position.set(0, this.nameLabel.y - 20);
    if (this.state.says) this.say(this.state.says);
    void CELL_W;
  }

  /** Redraw the furniture after a theme change. The cat itself is tinted from
   *  `avatar_config`, which does not depend on the theme. */
  repaintRoom(): void {
    if (this.state) this.redraw();
  }

  /** Draw again once the sheet is in, for a scene that is otherwise still. */
  refresh(): void {
    if (this.drawn || !this.state) return;
    this.paint(lookFor(this.state.avatar));
  }
}
