/**
 * The PixiJS application: floor, desks, characters, camera (§4 `scene/engine`).
 *
 * Deliberately dumb. It takes a `SceneState` and draws it; every decision about
 * *what* is true was already made by `scene/bindings`, which is pure and
 * tested. Nothing here reads an event, a store or the network.
 *
 * M7 adds movement, and it is worth being exact about what that means: a
 * character's *position* is derived — their seat, or the front of the room when
 * they are the one the mission turns on. Walking is only how this class gets
 * them from the old position to the new one. The same is true of the camera: it
 * looks at a point `cameraTarget` computed, and merely takes a moment to
 * arrive.
 */
import { Application, Container, Graphics } from "pixi.js";

import type { SceneState } from "../bindings/sceneState";
import { ActorView } from "../entities/actor";
import { loadCats } from "../entities/sheet";
import { roomColours } from "../entities/room";
import {
  TILE_H,
  TILE_W,
  cameraTarget,
  floorExtent,
  floorSpot,
  seatPositions,
  toScreen,
  type Point,
} from "./iso";

/** Character walking speed, in screen pixels per second. */
const WALK_SPEED = 190;
/** How fast the camera converges on its target; higher is snappier. */
const CAMERA_EASE = 3.2;
/** Closer than this and a character is treated as standing still. */
const ARRIVED = 1.5;

export class Scene {
  private app: Application | null = null;
  private world = new Container();
  private floor = new Graphics();
  private actors = new Map<string, ActorView>();
  //: The last thing asked for, so it can be drawn again once the sheet lands.
  private last: { state: SceneState; layoutId: string | null } | null = null;
  private targets = new Map<string, Point>();
  private layoutId: string | null = null;
  private seats = 0;
  //: Which floor colour is on screen, so a theme change is noticed.
  private paintedWith: number | null = null;
  private elapsed = 0;
  private camera: Point | null = null;
  private cameraWant: Point = { x: 0, y: 0 };
  private scaleWant = 1;
  private sizeWatcher: ResizeObserver | null = null;

  async mount(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      // Off: every sprite in this scene is pixel art, and smoothing its edges
      // is the one setting that makes good art look like bad art.
      antialias: false,
      // Transparent, so the ground comes from the element behind the canvas
      // and follows the theme with everything else. A `background` colour here
      // would be a fifth place that has an opinion about what colour the app
      // is, and the one nobody looks at is the one that goes stale.
      backgroundAlpha: 0,
      width: host.clientWidth || 800,
      height: host.clientHeight || 300,
      // Matches the page's device pixel ratio so the iso edges stay crisp.
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    host.appendChild(app.canvas);

    // Started here, not awaited: the room should come up immediately and the
    // cats arrive when they arrive.
    //
    // What it does on arrival is **re-render the last state**, not just poke
    // the actors that happen to exist. The first version refreshed
    // `this.actors`, which is empty at mount — so when the sheet lost the race
    // against the first render every actor had already given up, and a
    // finished mission produces no second state to try again with. The room
    // stayed black. That is the M7 bug ("the scene only drew when something
    // changed") in a new place, and the fix is the same shape: keep the last
    // state and draw it again when the thing you were missing turns up.
    void loadCats().then(() => {
      for (const actor of this.actors.values()) actor.refresh();
      if (this.last) this.render(this.last.state, this.last.layoutId);
    });

    // The pane changes height when the splitter moves, which is not a window
    // resize — `resizeTo` would never hear about it (§17.1).
    this.sizeWatcher = new ResizeObserver(([entry]) => {
      if (!entry || !this.app) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) this.app.renderer.resize(width, height);
    });
    this.sizeWatcher.observe(host);
    app.stage.addChild(this.world);
    this.world.addChild(this.floor);
    this.app = app;

    app.ticker.add((ticker) => {
      const dt = Math.min(ticker.deltaMS, 100) / 1000;
      this.elapsed += dt;
      this.step(dt);
      for (const actor of this.actors.values()) actor.tick(this.elapsed);
    });
  }

  /**
   * Start or stop the animation loop (§17.1).
   *
   * Not a flag the ticker checks — the ticker itself is stopped. A callback
   * that runs sixty times a second to decide it has nothing to do is still a
   * callback running sixty times a second.
   */
  setAnimating(animating: boolean): void {
    const ticker = this.app?.ticker;
    if (!ticker) return;
    if (animating && !ticker.started) ticker.start();
    if (!animating && ticker.started) ticker.stop();
  }

  get animating(): boolean {
    return this.app?.ticker.started ?? false;
  }

  destroy(): void {
    this.sizeWatcher?.disconnect();
    this.sizeWatcher = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
    this.actors.clear();
    this.targets.clear();
    this.camera = null;
  }

  render(state: SceneState, layoutId: string | null): void {
    if (!this.app) return;
    this.last = { state, layoutId };

    const positions = seatPositions(layoutId, state.seats);
    // The floor is redrawn when the room changes *or* when the palette does.
    // Without the second test, switching theme left an afternoon floor under
    // dusk furniture until someone happened to open a differently shaped team.
    const paint = roomColours().floorA;
    if (
      layoutId !== this.layoutId ||
      state.seats !== this.seats ||
      paint !== this.paintedWith
    ) {
      this.layoutId = layoutId;
      this.seats = state.seats;
      this.paintedWith = paint;
      this.drawFloor(positions);
      for (const actor of this.actors.values()) actor.repaintRoom();
    }

    const front = floorSpot(positions);
    const seen = new Set<string>();

    for (const actor of state.actors) {
      seen.add(actor.agentId);
      let view = this.actors.get(actor.agentId);
      const fresh = !view;
      if (!view) {
        view = new ActorView();
        this.actors.set(actor.agentId, view);
        this.world.addChild(view);
      }
      // A seat outside the layout would place a character nowhere; the
      // validator blocks that before launch, and this keeps them on screen if
      // one ever slips through (§8).
      const cell = positions[actor.seatIndex] ?? positions[0] ?? { x: 0, y: 0 };
      const where = actor.place === "floor" ? front : cell;
      const target = toScreen(where.x, where.y);
      this.targets.set(actor.agentId, target);
      // A character appearing for the first time starts where they belong
      // rather than walking in from the origin.
      if (fresh) view.position.set(target.x, target.y);
      view.update(actor);
    }

    for (const [id, view] of this.actors) {
      if (seen.has(id)) continue;
      view.destroy();
      this.actors.delete(id);
      this.targets.delete(id);
    }

    this.world.sortableChildren = true;
    this.aim(state, positions);

    // Place the camera now if nothing is going to.
    //
    // `step()` is what turns `cameraWant` into `world.position`, and `step()`
    // only runs on the ticker — which is stopped whenever the scene is not
    // animating, and it is not animating when the window is in the background
    // or the pane is collapsed. So opening a finished run in an unfocused
    // window drew the room correctly at world (0, 0): desks, cats, captions,
    // all of it just off the top-left corner, which looks exactly like nothing
    // was drawn at all.
    //
    // A zero-length step snaps rather than eases, which is right — there is no
    // previous view to travel from.
    //
    // And then paint once, by hand. Pixi renders **on the ticker**, so a
    // stopped ticker means a scene graph that is entirely correct and never
    // drawn — desks, cats, captions, all present, all invisible. That is worse
    // than a crash, because everything downstream reports success.
    if (!this.app.ticker.started) {
      this.step(0);
      this.app.render();
    }
  }

  /** Move everything a frame's worth toward where it should be. */
  private step(dt: number): void {
    for (const [id, view] of this.actors) {
      const target = this.targets.get(id);
      if (!target) continue;
      const dx = target.x - view.position.x;
      const dy = target.y - view.position.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= ARRIVED) {
        view.position.set(target.x, target.y);
        view.setWalking(0);
      } else {
        const stride = Math.min(distance, WALK_SPEED * dt);
        view.position.set(
          view.position.x + (dx / distance) * stride,
          view.position.y + (dy / distance) * stride,
        );
        // Sign, not magnitude: which way they face while moving.
        view.setWalking(Math.sign(dx) || 1);
      }
      // Painter's algorithm: further down the screen draws in front. Recomputed
      // while walking, so someone crossing the room passes in front of the
      // desks they walk past rather than through them.
      view.zIndex = view.position.y;
    }

    if (!this.app) return;
    if (!this.camera) {
      this.camera = { ...this.cameraWant };
    } else {
      const k = 1 - Math.exp(-CAMERA_EASE * dt);
      this.camera.x += (this.cameraWant.x - this.camera.x) * k;
      this.camera.y += (this.cameraWant.y - this.camera.y) * k;
    }
    const scale =
      this.world.scale.x +
      (this.scaleWant - this.world.scale.x) * (1 - Math.exp(-CAMERA_EASE * dt));
    this.world.scale.set(scale);
    this.world.position.set(
      this.app.screen.width / 2 - this.camera.x * scale,
      this.app.screen.height * 0.52 - this.camera.y * scale,
    );
  }

  private drawFloor(positions: Point[]): void {
    const { w, h } = floorExtent(positions);
    const g = this.floor;
    const paint = roomColours();
    g.clear();
    g.zIndex = -1;

    for (let gx = -1; gx < w; gx += 1) {
      for (let gy = -1; gy < h; gy += 1) {
        const p = toScreen(gx, gy);
        // Daylight falls from the top-right corner, the same direction as the
        // one wash left on the page behind the app. Applied per tile as a
        // second pass rather than as a gradient over the whole floor: the
        // floor is a grid of flat diamonds and a smooth ramp across it would
        // be the one soft edge in a scene made entirely of hard ones.
        const lit = Math.max(0, 1 - (gx + (h - 1 - gy)) / (w + h));
        g.moveTo(p.x, p.y)
          .lineTo(p.x + TILE_W, p.y + TILE_H)
          .lineTo(p.x, p.y + TILE_H * 2)
          .lineTo(p.x - TILE_W, p.y + TILE_H)
          .closePath()
          .fill({ color: (gx + gy) % 2 === 0 ? paint.floorA : paint.floorB });
        if (lit > 0.05) {
          g.moveTo(p.x, p.y)
            .lineTo(p.x + TILE_W, p.y + TILE_H)
            .lineTo(p.x, p.y + TILE_H * 2)
            .lineTo(p.x - TILE_W, p.y + TILE_H)
            .closePath()
            .fill({ color: paint.window, alpha: lit * paint.windowAlpha });
        }
      }
    }
  }

  /** Point the camera at whoever has the floor, and fit the room otherwise. */
  private aim(state: SceneState, positions: Point[]): void {
    if (!this.app) return;
    const { w, h } = floorExtent(positions);
    const width = this.app.screen.width;
    const height = this.app.screen.height;

    const roomW = (w + h) * TILE_W;
    const roomH = (w + h) * TILE_H;
    const fit = Math.min(1, (width * 0.9) / roomW, (height * 0.85) / roomH);

    const focus =
      state.actors.find((a) => a.agentId === state.focusAgentId) ?? null;
    this.cameraWant = cameraTarget(
      focus ? focus.seatIndex : null,
      focus?.place ?? "seat",
      positions,
    );
    // A gentle push-in when the room has a subject, so that "someone has the
    // floor" reads without a caption. Never enough to crop anyone out.
    this.scaleWant = focus ? Math.min(1, fit * 1.12) : fit;
  }
}
