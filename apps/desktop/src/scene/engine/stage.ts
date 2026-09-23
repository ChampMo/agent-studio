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
 *
 * **The first import is why the room appears at all in a shipped build.**
 * Pixi's WebGL renderer writes its uniform and shader sync routines with
 * `new Function`, so `Application.init()` throws
 * `Current environment does not allow unsafe-eval` under any Content Security
 * Policy that does not grant `'unsafe-eval'` — and this app ships one that
 * does not. The renderer never existed, so no canvas was ever added and the
 * scene pane drew its own buttons over nothing.
 *
 * The alternative fix is to put `'unsafe-eval'` in the policy, and it is the
 * wrong one here. This is the app that runs model output and reads fetched web
 * pages (§2.7); handing the page `eval` to save a few microseconds of uniform
 * upload is the trade backwards. `pixi.js/unsafe-eval` is Pixi's own answer:
 * the same routines, interpreted instead of generated.
 *
 * It is a side-effect import and it must be evaluated before any renderer is
 * constructed. Imports are hoisted and run before this module's body, so
 * sitting at the top of the only file that calls `new Application()` is
 * exactly the guarantee that needs to hold.
 *
 * **Dev could never have caught this.** Vite serves no CSP, so the generated
 * path works there and every check this project has ever run — including the
 * packaged-build check in M7, which predates the art — was made somewhere the
 * policy was absent.
 */
import "pixi.js/unsafe-eval";

import {
  Application,
  Container,
  Graphics,
  Sprite,
  loadTextures,
} from "pixi.js";

import type { SceneState, Throw } from "../bindings/sceneState";
import { playChime } from "../audio";
import { ActorView } from "../entities/actor";
import { loadCats } from "../entities/sheet";
import { loadPictures } from "../entities/picture";

/**
 * The second half of the same problem, found in the same console.
 *
 * Pixi decodes textures in a Web Worker it builds from a `blob:` URL. Tauri
 * does not ship the policy as written in `tauri.conf.json` — it rewrites it,
 * turning `default-src 'self'` into an explicit
 * `script-src 'self' 'sha256-…'` list covering its own injected scripts. A
 * hash-based `script-src` does not admit a blob worker, and `worker-src` falls
 * back to it, so `new Worker(blob:…)` is refused.
 *
 * The drawn cats never noticed: `artFetch` uses `new Image()` and
 * `Texture.from(HTMLImageElement)`, which touches no worker. `Assets.load` in
 * `sheet.ts` does, and that is the sprite-sheet fallback — the path taken
 * exactly when a cat has no drawing, which is the path nobody exercises until
 * an old `roster_snapshot` names a breed this build cannot draw (§5.1, §8).
 * A fallback that fails is worse than no fallback, because it is silent.
 *
 * Decoding on the main thread is the cost, and for the handful of textures
 * this app loads once at startup it is not a cost worth a CSP hole for.
 *
 * Worth recording how this was nearly missed: a first test served the policy
 * as *written*, where `default-src 'self'` alone was enough — Chromium lets a
 * blob worker inherit the document's origin — and reported ALLOWED. The policy
 * the app actually runs under is the one Tauri assembles, and only the real
 * binary could say what that was.
 */
if (loadTextures.config) loadTextures.config.preferWorkers = false;
import { decorSpots, drawRoom } from "../entities/room";
import { loadRoomArt, pieceFoot, pieceTexture } from "../entities/roomArt";
import { loadToolArt } from "../entities/toolArt";
import { loadThrowArt, throwTexture } from "../entities/throwArt";
import { roomColours } from "../entities/room";
import {
  TILE_H,
  cameraTarget,
  floorBounds,
  floorCorners,
  floorExtent,
  floorSpot,
  roomSeats,
  toScreen,
  type Point,
} from "./iso";

/** Character walking speed, in screen pixels per second. */
const WALK_SPEED = 190;
/** How far in and out the view may go, as a factor of the automatic fit.
 *
 *  3x is where this art stops rewarding a closer look: past three times the
 *  source a drawing is blocks rather than a drawing. The lower bound is there
 *  so the room cannot be shrunk to a speck that is hard to find again — and
 *  it is where the walls come back into view, since the fit leaves them off
 *  the top. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
/** The most the automatic fit will magnify. A very large pane fills with the
 *  floor up to this and then leaves a margin, rather than turning a 100px cat
 *  into blocks. */
const FIT_MAX = 3;
/** How far above the middle of the floor the camera rests, in world pixels,
 *  when nobody has the floor. Zoomed in, the view is tighter than the room,
 *  and what should stay in it is the far end — the head of the table and the
 *  walls — rather than the empty floor in front. Bigger lifts the view. */
const REST_LIFT = TILE_H * 1.5;
/** A wheel notch. Multiplicative, because zoom is a ratio — a fixed step feels
 *  enormous when zoomed out and imperceptible when zoomed in. */
const ZOOM_STEP = 1.12;
/** Arrow-key pan, in screen pixels per press. */
const PAN_STEP = 48;


/** How fast the camera converges on its target; higher is snappier. */
const CAMERA_EASE = 3.2;
/** Closer than this and a character is treated as standing still. */
const ARRIVED = 1.5;
/** How long a thrown thing is in the air, and how high it goes. */
const THROW_SEC = 1.2;
const THROW_ARC = 70;
/** After landing: how long it sits in the recipient's hands, then how long
 *  it takes to fade. A thing that vanished on touch was never seen arrive. */
const LINGER_SEC = 0.6;
const FADE_SEC = 0.4;
/** How tall a thrown thing's 50px canvas is drawn, in world units. */
const THROW_H = TILE_H * 3;

/** One thing in the air. */
interface Flight {
  sprite: Sprite;
  from: Point;
  to: Point;
  /** 0..1 along the flight. */
  t: number;
  /** Seconds since landing. */
  rest: number;
}

export class Scene {
  private app: Application | null = null;
  private world = new Container();
  private floor = new Graphics();
  //: The furniture against the walls. One sprite per spot, made on first use.
  private readonly decor: Sprite[] = [];
  private actors = new Map<string, ActorView>();
  //: Things in the air right now.
  private flights: Flight[] = [];
  //: The floor as last drawn, for where "the front of the room" is.
  private extent: { w: number; h: number } | null = null;
  //: The last thing asked for, so it can be drawn again once the sheet lands.
  private last: { state: SceneState; layoutId: string | null } | null = null;
  private targets = new Map<string, Point>();
  private layoutId: string | null = null;
  private seats = 0;
  //: Which seats are taken, as a key: the floor is sized to the desks in use.
  private occupiedKey = "";
  //: Which floor colour is on screen, so a theme change is noticed.
  private paintedWith: number | null = null;
  private elapsed = 0;
  private camera: Point | null = null;
  private cameraWant: Point = { x: 0, y: 0 };
  private scaleWant = 1;
  private sizeWatcher: ResizeObserver | null = null;

  //: Where the automatic camera would put things, kept even while a person is
  //: driving, so "put it back" has something to put it back to.
  private autoWant: Point = { x: 0, y: 0 };
  private autoScale = 1;
  //: The fit for the current room and pane, which the zoom limits are relative
  //: to. A room that does not fit at 1:1 should still zoom out from where it
  //: actually starts.
  private fitScale = 1;
  //: Set the moment somebody pans or zooms, and cleared by `recentre`.
  //:
  //: The camera frames itself until it is touched, and then it is yours. The
  //: alternative — automatic always wins — means every event yanks the view
  //: back from wherever you were looking, which makes inspecting anything
  //: impossible during the one thing worth inspecting, a run in progress.
  private driven = false;
  private onDrive: (() => void) | null = null;
  private detachInput: (() => void) | null = null;

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
    // Both, together: a cat draws from a picture when it has one and from
    // the sheet when it does not, and starting on one before the other has
    // answered is how an actor ends up composited and then replaced.
    void Promise.all([loadCats(), loadPictures(), loadRoomArt(), loadToolArt(), loadThrowArt()]).then(() => {
      for (const actor of this.actors.values()) actor.refresh();
      // The room is drawn once per layout and per palette, and the first
      // draw almost always happens before the furniture has loaded — so it
      // is drawn without it and, with nothing else changing, would stay that
      // way. Forgetting what it was painted with is what makes the next
      // render draw it again, furniture included.
      this.paintedWith = null;
      if (this.last) this.render(this.last.state, this.last.layoutId);
    });

    // The pane changes height when the splitter moves, which is not a window
    // resize — `resizeTo` would never hear about it (§17.1).
    this.sizeWatcher = new ResizeObserver(([entry]) => {
      if (!entry || !this.app) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      this.app.renderer.resize(width, height);
      // A new pane is a new fit. `aim()` only runs inside `render()`, so
      // without this the room kept the scale it was given by the pane it
      // first drew in: closing the right rail left a room sized for a
      // 270px column in the middle of a 625px one, until the next event
      // happened to come along.
      if (this.last) this.render(this.last.state, this.last.layoutId);
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

    this.detachInput = this.wireCamera(app.canvas);
  }

  /**
   * Hand the app to Pixi's devtools, and to anyone checking a drawing from
   * the console. Dev only — a shipped build has no business exposing its
   * scene graph — and called by the owner once this instance is the one it
   * kept, **not** from `mount()`. React's development double-mount runs two
   * mounts, and the cancelled one can finish last: it then overwrote the
   * handle and, being destroyed a moment later, took it down with itself,
   * leaving nothing exposed while a perfectly good scene was on screen.
   */
  expose(): void {
    if (import.meta.env.DEV && this.app) {
      const g = globalThis as { __PIXI_APP__?: unknown; __SCENE__?: unknown };
      g.__PIXI_APP__ = this.app;
      g.__SCENE__ = this;
    }
  }

  /**
   * Wheel to zoom, drag to pan, arrows for both.
   *
   * Every one of these ends in `this.settle()` rather than in a state change
   * and a hope. `step()` is what turns `cameraWant` into `world.position`, and
   * Pixi paints on the ticker — which is **stopped** whenever the pane is
   * collapsed or the window is behind another one. A drag in that state would
   * move a number and nothing else, which is the same failure this file has
   * already hit twice: a camera that only moved on the ticker drew the room
   * off the top-left corner, and a stopped ticker left a scene graph that was
   * entirely correct and never painted.
   *
   * Keyboard as well as pointer, because a camera that needs a mouse is one
   * some people cannot move at all (WCAG 2.1.1). The canvas takes focus for
   * it, which is also what makes the wheel handler safe to be passive-free:
   * it only claims the event when the pointer is actually over the scene.
   */
  private wireCamera(canvas: HTMLCanvasElement): () => void {
    canvas.tabIndex = 0;
    canvas.style.touchAction = "none";
    canvas.style.outline = "none";

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const wheel = (event: WheelEvent) => {
      // Not passive: without this the wheel scrolls the panel the scene sits
      // in, so zooming walks the page instead.
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      this.zoomAt(
        event.clientX - box.left,
        event.clientY - box.top,
        event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
      );
    };

    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
    };

    const move = (event: PointerEvent) => {
      if (!dragging) return;
      this.panBy(event.clientX - lastX, event.clientY - lastY);
      lastX = event.clientX;
      lastY = event.clientY;
    };

    const up = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);
      canvas.style.cursor = "";
    };

    const key = (event: KeyboardEvent) => {
      const pan: Record<string, [number, number]> = {
        ArrowLeft: [PAN_STEP, 0],
        ArrowRight: [-PAN_STEP, 0],
        ArrowUp: [0, PAN_STEP],
        ArrowDown: [0, -PAN_STEP],
      };
      const nudge = pan[event.key];
      if (nudge) {
        event.preventDefault();
        this.panBy(nudge[0], nudge[1]);
        return;
      }
      const middle = () => {
        const box = canvas.getBoundingClientRect();
        return [box.width / 2, box.height / 2] as const;
      };
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        this.zoomAt(...middle(), ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        this.zoomAt(...middle(), 1 / ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        this.recentre();
      }
    };

    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("keydown", key);
    return () => {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("keydown", key);
    };
  }

  /** Apply the camera and paint one frame, whether or not the ticker is on. */
  private settle(): void {
    if (!this.app) return;
    // Zero-length: snap to where the numbers now say, rather than easing from
    // a view the person has already moved past with the pointer.
    this.step(0);
    if (!this.app.ticker.started) this.app.render();
  }

  private take(): void {
    if (this.driven) return;
    this.driven = true;
    this.onDrive?.();
  }

  /**
   * Zoom about a point on the canvas rather than about the middle.
   *
   * Zooming to the centre pushes whatever you were leaning in to look at off
   * the side, which is the opposite of what the gesture was for.
   */
  private zoomAt(px: number, py: number, factor: number): void {
    if (!this.app) return;
    this.take();
    const from = this.world.scale.x || this.scaleWant;
    const to = Math.min(
      this.fitScale * ZOOM_MAX,
      Math.max(this.fitScale * ZOOM_MIN, from * factor),
    );
    if (to === from) return;
    // The world point under the cursor has to stay under the cursor, which
    // fixes where the camera must be once the scale has changed.
    const world = {
      x: (px - this.world.position.x) / from,
      y: (py - this.world.position.y) / from,
    };
    this.scaleWant = to;
    this.world.scale.set(to);
    this.cameraWant = {
      x: world.x - (px - this.app.screen.width / 2) / to,
      y: world.y - (py - this.app.screen.height * 0.52) / to,
    };
    this.camera = { ...this.cameraWant };
    this.settle();
  }

  /** Drag: screen pixels, converted to world units by the current scale. */
  private panBy(dx: number, dy: number): void {
    this.take();
    const scale = this.world.scale.x || 1;
    this.cameraWant = {
      x: this.cameraWant.x - dx / scale,
      y: this.cameraWant.y - dy / scale,
    };
    this.camera = { ...this.cameraWant };
    this.settle();
  }

  /** Hand the camera back. */
  recentre(): void {
    if (!this.driven) return;
    this.driven = false;
    this.cameraWant = { ...this.autoWant };
    this.scaleWant = this.autoScale;
    this.onDrive?.();
    this.settle();
  }

  /** Whether a person is currently driving, so the UI can offer to stop. */
  get cameraDriven(): boolean {
    return this.driven;
  }

  /** Told when that changes, so a button can appear and disappear. */
  onCameraChange(fn: (() => void) | null): void {
    this.onDrive = fn;
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
    // If this is the app the dev handle points at, take the handle down with
    // it. React's development double-mount can leave the *cancelled* mount as
    // the last one to set it, so without this the hook would name an app
    // whose renderer is already gone.
    const g = globalThis as { __PIXI_APP__?: unknown };
    if (g.__PIXI_APP__ === this.app) delete g.__PIXI_APP__;
    this.detachInput?.();
    this.detachInput = null;
    this.onDrive = null;
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

    // The leader's own seat, so the head of the table is theirs. Read off the
    // frozen roster the actors came from rather than assumed to be seat 0 —
    // nothing makes a leader sit there, and a real team on this machine has
    // one in seat 4.
    const leaderSeat =
      state.actors.find((a) => a.isLeader)?.seatIndex ?? null;
    const occupied = state.actors.map((a) => a.seatIndex);
    const seating = roomSeats(layoutId, state.seats, occupied, leaderSeat);
    const positions = seating.bySeat;
    const occupiedKey = [...occupied].sort((a, b) => a - b).join(",");
    // The floor is redrawn when the room changes *or* when the palette does.
    // Without the second test, switching theme left an afternoon floor under
    // dusk furniture until someone happened to open a differently shaped team.
    const paint = roomColours().floorA;
    if (
      layoutId !== this.layoutId ||
      state.seats !== this.seats ||
      occupiedKey !== this.occupiedKey ||
      paint !== this.paintedWith
    ) {
      this.layoutId = layoutId;
      this.seats = state.seats;
      this.occupiedKey = occupiedKey;
      this.paintedWith = paint;
      this.drawFloor(seating.used);
      for (const actor of this.actors.values()) actor.repaintRoom();
    }

    const front = floorSpot(seating.used);
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
      // The view stands at the seat — that is where the desk is — and only
      // its `body` walks, so the target is where the body should be relative
      // to the desk it belongs to.
      const seat = toScreen(cell.x, cell.y);
      const spot = toScreen(where.x, where.y);
      const target = { x: spot.x - seat.x, y: spot.y - seat.y };
      view.position.set(seat.x, seat.y);
      this.targets.set(actor.agentId, target);
      // A character appearing for the first time starts where they belong
      // rather than walking in from the origin.
      if (fresh) view.body.position.set(target.x, target.y);
      view.update(actor);
    }

    for (const [id, view] of this.actors) {
      if (seen.has(id)) continue;
      view.destroy();
      this.actors.delete(id);
      this.targets.delete(id);
    }

    this.world.sortableChildren = true;
    this.aim(state, positions, seating.used);

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
      const body = view.body;
      const dx = target.x - body.position.x;
      const dy = target.y - body.position.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= ARRIVED) {
        body.position.set(target.x, target.y);
        view.setWalking(0);
      } else {
        const stride = Math.min(distance, WALK_SPEED * dt);
        body.position.set(
          body.position.x + (dx / distance) * stride,
          body.position.y + (dy / distance) * stride,
        );
        // Sign, not magnitude: which way they face while moving.
        view.setWalking(Math.sign(dx) || 1);
      }
      // Painter's algorithm: further down the screen draws in front. Sorted by
      // where the cat is, not the desk, so someone crossing the room passes in
      // front of the desks they walk past rather than through them.
      view.zIndex = view.position.y + body.position.y;
    }

    // Things in the air: a straight line between the two cats with a hop on
    // it, spinning a little, gone on landing.
    for (const flight of this.flights) {
      if (flight.t < 1) {
        flight.t = Math.min(1, flight.t + dt / THROW_SEC);
        const k = flight.t;
        const hop = Math.sin(k * Math.PI) * THROW_ARC;
        flight.sprite.position.set(
          flight.from.x + (flight.to.x - flight.from.x) * k,
          flight.from.y + (flight.to.y - flight.from.y) * k - hop,
        );
        flight.sprite.rotation = Math.sin(k * Math.PI * 2) * 0.35;
        if (k >= 1) playChime("land");
        continue;
      }
      // Landed: held for a moment, then faded, then gone.
      flight.rest += dt;
      flight.sprite.alpha = Math.max(0, 1 - Math.max(0, flight.rest - LINGER_SEC) / FADE_SEC);
      if (flight.rest >= LINGER_SEC + FADE_SEC) {
        this.world.removeChild(flight.sprite);
        flight.sprite.destroy();
      }
    }
    this.flights = this.flights.filter((f) => f.rest < LINGER_SEC + FADE_SEC);

    if (!this.app) return;
    // A zero-length step is a *snap*, not a very small ease. `settle()` says
    // as much in its own comment, and `render()` relies on it for a scene
    // whose ticker is stopped — a finished run, a paused one, a background
    // window. The ease alone gives `k = 1 - e^0 = 0` there: the camera's
    // position happened to be right only because it is initialised to its
    // target on the first frame, and the scale, which has no such first
    // frame, stayed wherever it was. That was invisible while the room fitted
    // the pane at 1:1 and is the whole picture the moment it does not.
    const snap = dt === 0 || !this.camera;
    if (snap || !this.camera) {
      this.camera = { ...this.cameraWant };
    } else {
      const k = 1 - Math.exp(-CAMERA_EASE * dt);
      this.camera.x += (this.cameraWant.x - this.camera.x) * k;
      this.camera.y += (this.cameraWant.y - this.camera.y) * k;
    }
    const scale = snap
      ? this.scaleWant
      : this.world.scale.x +
        (this.scaleWant - this.world.scale.x) * (1 - Math.exp(-CAMERA_EASE * dt));
    this.world.scale.set(scale);
    this.world.position.set(
      this.app.screen.width / 2 - this.camera.x * scale,
      this.app.screen.height * 0.60 - this.camera.y * scale,
    );
  }

  /**
   * Throw something across the room, from one cat to another.
   *
   * Called by the owner for a throw that *just happened* — that gate is the
   * owner's, shared with the chime, because this class knows nothing about
   * replays. A throw whose ends it cannot place, or whose picture did not
   * arrive, is simply not thrown. Nothing moves unless the ticker is
   * running, so a background window throws nothing and loses nothing: the
   * log still says what was sent.
   */
  throw_(item: Throw): void {
    if (!this.app?.ticker.started) return;
    const from = this.whereIs(item.from);
    const to = this.whereIs(item.to);
    const texture = throwTexture(item.kind, item.seq);
    if (!from || !to || !texture) return;
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.scale.set(THROW_H / texture.height);
    sprite.position.set(from.x, from.y);
    // Over everything on the floor: it is in the air.
    sprite.zIndex = 1e6;
    this.world.addChild(sprite);
    this.flights.push({ sprite, from, to, t: 0, rest: 0 });
    // Downstream of the same "just happened" gate as the throw itself, so a
    // replay is as silent as it is still.
    playChime("throw");
  }

  /** A cat's hands, or the front of the room for the person. */
  private whereIs(who: string | "front"): Point | null {
    if (who === "front") {
      if (!this.extent) return null;
      const near = floorCorners(this.extent).bottom;
      return { x: near.x, y: near.y - TILE_H };
    }
    const view = this.actors.get(who);
    if (!view) return null;
    return { x: view.x + view.body.x, y: view.y + view.body.y - TILE_H * 0.4 };
  }

  private drawFloor(positions: Point[]): void {
    const extent = floorExtent(positions);
    this.extent = extent;
    this.floor.zIndex = -1;
    drawRoom(this.floor, extent, roomColours());
    this.placeDecor(extent);
  }

  /**
   * Stand the delivered furniture against the drawn walls.
   *
   * Each piece is anchored at its **foot** — the lowest ink in its picture,
   * measured by `roomArt` — and that point is set on the spot. That is what
   * keeps a bookcase drawn at 2:1 on the skirting rather than above it: the
   * canvas's bottom-centre is below the drawing's real base, and a sprite
   * anchored there floats by exactly that gap.
   *
   * Each piece sorts with everything else by where its foot is, so the
   * plant in the front corner stands in front of a desk behind it and the
   * window — whose foot is up the wall — sits behind everything. A piece
   * with no picture is simply not placed.
   */
  private placeDecor(extent: { w: number; h: number }): void {
    for (const sprite of this.decor) sprite.visible = false;
    decorSpots(extent).forEach((spot, index) => {
      const texture = pieceTexture(spot.piece);
      if (!texture) return;
      let sprite = this.decor[index];
      if (!sprite) {
        sprite = new Sprite(texture);
        this.decor[index] = sprite;
        this.world.addChild(sprite);
      } else {
        sprite.texture = texture;
      }
      const foot = pieceFoot(spot.piece);
      sprite.anchor.set(foot.x, foot.y);
      sprite.visible = true;
      const scale = spot.height / texture.height;
      sprite.scale.set(scale);
      // A flat base straddles the skirting line if its middle sits on it —
      // half of it over the wall. Set it into the room by half its width at
      // the walls' 2:1 slope, which is exactly when the whole base is on the
      // floor.
      const inset = spot.flat ? (texture.width * scale) / 4 : 0;
      const y = spot.y + inset;
      sprite.position.set(Math.round(spot.x), Math.round(y));
      sprite.zIndex = y;
    });
  }


  /** Point the camera at whoever has the floor, and fit the room otherwise. */
  private aim(state: SceneState, positions: Point[], room: Point[]): void {
    if (!this.app) return;
    const width = this.app.screen.width;
    const height = this.app.screen.height;

    // The floor, not the walls: the default view fills the pane with the
    // desks and lets the walls run off the top — `floorBounds` says why.
    // Bigger than 1:1 whenever the pane allows, which most panes do; the art
    // is sampled nearest-neighbour, so magnifying it keeps it crisp.
    const floor = floorBounds(room);
    // An empty room — a draft, before the first message — is not magnified:
    // there is nothing in it to look at, and a floor filled to the pane at
    // 3x is a wall of pixels behind the "send a team" line.
    const fit = Math.min(
      room.length ? FIT_MAX : 1,
      (width * 1.3) / floor.w,
      (height * 1.3) / floor.h,
    );
    // What the zoom limits are measured against. A room too big to fit at 1:1
    // still has to be able to zoom out from wherever it actually starts.
    this.fitScale = fit;

    const focus =
      state.actors.find((a) => a.agentId === state.focusAgentId) ?? null;
    this.autoWant = cameraTarget(
      focus ? focus.seatIndex : null,
      focus?.place ?? "seat",
      positions,
      room,
    );
    if (!focus) this.autoWant = { x: this.autoWant.x, y: this.autoWant.y - REST_LIFT };
    // A gentle push-in when the room has a subject, so that "someone has the
    // floor" reads without a caption. Never enough to crop anyone out.
    this.autoScale = focus ? Math.min(FIT_MAX, fit * 1.12) : fit;

    // Kept up to date but not applied while somebody is driving. Without this
    // the next event would yank the view back from wherever they were looking,
    // which is exactly what makes a live run impossible to inspect.
    if (this.driven) return;
    this.cameraWant = { ...this.autoWant };
    this.scaleWant = this.autoScale;
  }
}
