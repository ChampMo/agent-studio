/**
 * One character at one desk.
 *
 * Drawn from primitives rather than sprite sheets: the art does not exist yet,
 * and every shape here is driven by real data — `avatar_config` chosen from the
 * closed catalogue, and a pose derived from the event stream. Swapping in
 * artwork later replaces `redraw`, not the data path.
 *
 * Nothing is drawn that is not true (§1.1). There is a name, a pose word, and
 * the task the character is on. No bars, no numbers, no floating damage.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";

import type { Actor } from "../bindings/sceneState";
import { shapeFor } from "../animation/poses";
import { lookFor } from "./palette";
import { TILE_H, TILE_W } from "../engine/iso";

const LABEL = new TextStyle({
  fill: 0xcbd5e1,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: 13,
  fontWeight: "600",
});

const CAPTION = new TextStyle({
  fill: 0x64748b,
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
});

const SPEECH = new TextStyle({
  fill: 0x0f172a,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: 11,
  wordWrap: true,
  wordWrapWidth: 190,
  lineHeight: 15,
});

const TASK = new TextStyle({
  fill: 0x7dd3fc,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: 11,
  wordWrap: true,
  wordWrapWidth: 150,
  align: "center",
});

export class ActorView extends Container {
  private readonly desk = new Graphics();
  private readonly figure = new Graphics();
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
      this.desk,
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
    this.bubble.clear();
    this.speech.text = text ?? "";
    this.speech.visible = text !== null;
    if (text === null) return;

    const w = this.speech.width + 16;
    const h = this.speech.height + 12;
    const top = this.speech.y - h;
    this.bubble
      .roundRect(-w / 2, top, w, h, 8)
      .fill({ color: 0xe2e8f0 })
      // The tail, pointing down at whoever is speaking.
      .moveTo(-5, top + h)
      .lineTo(5, top + h)
      .lineTo(0, top + h + 7)
      .closePath()
      .fill({ color: 0xe2e8f0 });
  }

  private redraw(): void {
    if (!this.state) return;
    const shape = shapeFor(this.state.pose);
    const look = lookFor(this.state.avatar);
    const { palette, body, hair, outfit } = look;

    // ---- desk: an iso diamond with a front face ----
    this.desk.clear();
    this.desk
      .moveTo(0, 0)
      .lineTo(TILE_W, TILE_H)
      .lineTo(0, TILE_H * 2)
      .lineTo(-TILE_W, TILE_H)
      .closePath()
      .fill({ color: 0x1e293b })
      .stroke({ color: 0x334155, width: 1 });
    this.desk
      .moveTo(-TILE_W, TILE_H)
      .lineTo(0, TILE_H * 2)
      .lineTo(0, TILE_H * 2 + 10)
      .lineTo(-TILE_W, TILE_H + 10)
      .closePath()
      .fill({ color: 0x0f172a });

    // ---- figure ----
    const g = this.figure;
    g.clear();

    const h = 46 * body.h;
    const w = 15 * body.w;
    const lean = shape.lean * 18;
    const slump = shape.slump * 6;
    // Facing the desk mirrors the lean; facing the room turns it outward.
    const dir = shape.facing === "desk" ? 1 : -1;

    const baseY = TILE_H * 0.9;

    // legs
    g.rect(-w * 0.5, baseY - h * 0.4, w * 0.35, h * 0.4)
      .rect(w * 0.15, baseY - h * 0.4, w * 0.35, h * 0.4)
      .fill({ color: 0x1f2937 });

    // torso, leaning
    const torsoTop = baseY - h + slump;
    g.moveTo(-w * 0.6 + lean * dir, torsoTop)
      .lineTo(w * 0.6 + lean * dir, torsoTop)
      .lineTo(w * 0.7, baseY - h * 0.38)
      .lineTo(-w * 0.7, baseY - h * 0.38)
      .closePath()
      .fill({ color: palette.cloth });

    if (outfit.hem > 1) {
      g.rect(-w * 0.7, baseY - h * 0.38, w * 1.4, (outfit.hem - 1) * h * 0.5).fill({
        color: palette.cloth,
      });
    }
    if (outfit.belt) {
      g.rect(-w * 0.7, baseY - h * 0.42, w * 1.4, 3).fill({ color: palette.trim });
    }
    if (outfit.collar) {
      g.moveTo(-w * 0.35 + lean * dir, torsoTop)
        .lineTo(0 + lean * dir, torsoTop + 8)
        .lineTo(w * 0.35 + lean * dir, torsoTop)
        .closePath()
        .fill({ color: palette.trim });
    }

    // head
    const headR = w * 0.52;
    const headX = lean * dir * 1.15 + Math.sin(shape.headTilt) * 6;
    const headY = torsoTop - headR - 1;
    g.circle(headX, headY, headR).fill({ color: palette.skin });

    // hair
    if (hair.top > 0) {
      g.ellipse(headX, headY - headR * 0.45, headR * 1.05, headR * hair.top).fill({
        color: hair.hood ? palette.cloth : palette.hair,
      });
    }
    if (hair.side > 0) {
      g.ellipse(headX - headR * 0.9, headY + headR * 0.15, headR * 0.3, headR * hair.side)
        .ellipse(headX + headR * 0.9, headY + headR * 0.15, headR * 0.3, headR * hair.side)
        .fill({ color: hair.hood ? palette.cloth : palette.hair });
    }
    if (hair.tail) {
      g.ellipse(headX - headR * 1.1, headY + headR * 0.5, headR * 0.24, headR * 0.7).fill({
        color: palette.hair,
      });
    }

    this.nameLabel.position.set(0, torsoTop - headR * 3.1);
    this.caption.position.set(0, baseY + 6);
    this.task.position.set(0, baseY + 22);
    this.speech.position.set(0, this.nameLabel.y - 20);
    if (this.state.says) this.say(this.state.says);
  }
}
