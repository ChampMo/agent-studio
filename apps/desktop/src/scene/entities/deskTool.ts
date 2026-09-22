/**
 * The tool on the desk: the one in use, playing its loop, or nothing.
 *
 * A view and nothing more. `sceneState` decides which tool an agent is using
 * (an `agent.tool.start` without its end), `props.ts` decides which drawing
 * that is, and this puts the drawing's frames on a sprite. It is told the
 * tool on every update and is cheap to tell: the same tool twice does
 * nothing, so a loop already playing is not restarted by an unrelated event.
 *
 * Two drawings are more than a loop. The computer is a case whose lights
 * blink beside a monitor that does not; the toolbox is an open box with a
 * wrench floating above it — the artist's one request for the set, and the
 * only movement here that is not a frame sequence. Both claim nothing beyond
 * "this tool is running", which the frames already claim, so a timer may
 * drive them (§1.1).
 *
 * No art for a drawing — a frame missing, or the folder not delivered — and
 * the primitive from `props.ts` stands in at the same spot.
 */
import { AnimatedSprite, Container, Graphics, Sprite, Texture } from "pixi.js";

import { TILE_H } from "../engine/iso";
import { drawProp, propFor, type Prop } from "./props";
import type { RoomColours } from "./room";
import { toolExtra, toolFrames } from "./toolArt";

/** How tall a tool's canvas stands on the desk, in world units. Every frame
 *  is drawn on the same 50px square, so the whole set scales as one. */
const PROP_H = TILE_H * 2;
/** About four frames a second on a 60Hz ticker: slow enough that a pencil
 *  writing reads as writing rather than as flicker. */
const FRAME_SPEED = 0.07;
/** How far the wrench rises out of the open box, and how much it bobs. */
const WRENCH_RISE = PROP_H * 0.45;
const WRENCH_BOB = 4;
/** How long a tool stays on the desk at least, in ms. A `read_file` is over
 *  in a few milliseconds and a drawing that flashed for one frame said
 *  nothing; the log still decides *what* is shown, this only decides that
 *  it is shown long enough to be seen. A different tool replaces it at once. */
const MIN_SHOW_MS = 1500;

export class DeskTool extends Container {
  private readonly loop = new AnimatedSprite([Texture.EMPTY]);
  //: The monitor beside the computer's case: part of the drawing, not of
  //: the loop.
  private readonly still = new Sprite();
  private readonly wrench = new Sprite();
  private readonly primitive = new Graphics();
  private prop: Prop | null = null;
  //: When the current drawing went on the desk, and when it may come off
  //: if the log has already said the tool ended.
  private shownAt = 0;
  private hideAt: number | null = null;

  constructor() {
    super();
    this.loop.anchor.set(0.5, 1);
    this.loop.animationSpeed = FRAME_SPEED;
    this.still.anchor.set(0.5, 1);
    this.wrench.anchor.set(0.5, 1);
    this.addChild(this.primitive, this.loop, this.still, this.wrench);
    this.clear();
  }

  /** Put the drawing for `tool` on the desk, or nothing when there is none. */
  show(tool: string | null, paint: RoomColours): void {
    const prop = propFor(tool);
    if (prop === this.prop) {
      this.hideAt = null;
    } else if (prop === null && performance.now() - this.shownAt < MIN_SHOW_MS) {
      // Ended already; let it be seen. `tick` takes it off.
      this.hideAt = this.shownAt + MIN_SHOW_MS;
      return;
    } else {
      this.prop = prop;
      this.hideAt = null;
      this.clear();
      if (prop) {
        this.place(prop);
        this.shownAt = performance.now();
      }
    }
    // The fallback carries theme colours, so it is drawn on every call rather
    // than once: a theme change reaches it through the same redraw that
    // reaches the desk.
    this.primitive.clear();
    if (prop && !this.loop.visible) drawProp(this.primitive, prop, paint);
  }

  /** Every frame: the wrench floating over the open toolbox. */
  tick(elapsed: number): void {
    if (this.hideAt !== null && performance.now() >= this.hideAt) {
      this.hideAt = null;
      this.prop = null;
      this.clear();
    }
    if (!this.wrench.visible) return;
    this.wrench.y = -WRENCH_RISE - Math.sin(elapsed * 3) * WRENCH_BOB;
    this.wrench.rotation = Math.sin(elapsed * 2.1) * 0.12;
  }

  private clear(): void {
    this.loop.stop();
    this.loop.visible = false;
    this.loop.position.set(0, 0);
    this.still.visible = false;
    this.wrench.visible = false;
    this.primitive.clear();
  }

  private place(prop: Prop): void {
    const frames = toolFrames(prop);
    // No frames: `show` draws the primitive instead.
    if (frames.length === 0) return;
    this.loop.textures = frames;
    this.loop.scale.set(PROP_H / frames[0]!.height);
    this.loop.visible = true;
    this.loop.gotoAndPlay(0);

    if (prop === "computer") {
      // The case is the loop — its lights blink — and the monitor stands
      // still beside it, a little in front.
      const monitor = toolExtra("monitor");
      if (monitor) {
        this.still.texture = monitor;
        this.still.scale.set(PROP_H / monitor.height);
        this.still.position.set(PROP_H * 0.24, 2);
        this.still.visible = true;
        this.loop.position.set(-PROP_H * 0.2, 0);
      }
    }
    if (prop === "toolbox") {
      // The box is open, and the wrench floats up out of it. `tick` moves it.
      const wrench = toolExtra("wrench");
      if (wrench) {
        this.wrench.texture = wrench;
        this.wrench.scale.set((PROP_H * 0.8) / wrench.height);
        this.wrench.position.set(0, -WRENCH_RISE);
        this.wrench.visible = true;
      }
    }
  }
}
