/**
 * The PixiJS application: floor, desks, characters, camera (§4 `scene/engine`).
 *
 * Deliberately dumb. It takes a `SceneState` and draws it; every decision about
 * *what* is true was already made by `scene/bindings`, which is pure and
 * tested. Nothing here reads an event, a store or the network.
 *
 * No walking in M5 (§12): characters stand at their desks and change pose.
 */
import { Application, Container, Graphics } from "pixi.js";

import type { SceneState } from "../bindings/sceneState";
import { ActorView } from "../entities/actor";
import { TILE_H, TILE_W, floorExtent, seatPositions, toScreen } from "./iso";

export class Scene {
  private app: Application | null = null;
  private world = new Container();
  private floor = new Graphics();
  private actors = new Map<string, ActorView>();
  private layoutId: string | null = null;
  private seats = 0;
  private elapsed = 0;

  async mount(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      background: 0x0b1120,
      antialias: true,
      resizeTo: host,
      // Matches the page's device pixel ratio so the iso edges stay crisp.
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    host.appendChild(app.canvas);
    app.stage.addChild(this.world);
    this.world.addChild(this.floor);
    this.app = app;

    app.ticker.add((ticker) => {
      this.elapsed += ticker.deltaMS / 1000;
      for (const actor of this.actors.values()) actor.tick(this.elapsed);
    });
  }

  destroy(): void {
    this.app?.destroy(true, { children: true });
    this.app = null;
    this.actors.clear();
  }

  render(state: SceneState, layoutId: string | null): void {
    if (!this.app) return;

    const positions = seatPositions(layoutId, state.seats);
    if (layoutId !== this.layoutId || state.seats !== this.seats) {
      this.layoutId = layoutId;
      this.seats = state.seats;
      this.drawFloor(positions);
    }

    const seen = new Set<string>();
    for (const actor of state.actors) {
      seen.add(actor.agentId);
      let view = this.actors.get(actor.agentId);
      if (!view) {
        view = new ActorView();
        this.actors.set(actor.agentId, view);
        this.world.addChild(view);
      }
      // A seat outside the layout would place a character nowhere; the
      // validator blocks that before launch, and this keeps them on screen if
      // one ever slips through (§8).
      const cell = positions[actor.seatIndex] ?? positions[0] ?? { x: 0, y: 0 };
      const p = toScreen(cell.x, cell.y);
      view.position.set(p.x, p.y);
      // Painter's algorithm: further down the screen draws in front.
      view.zIndex = p.y;
      view.update(actor);
    }

    for (const [id, view] of this.actors) {
      if (seen.has(id)) continue;
      view.destroy();
      this.actors.delete(id);
    }

    this.world.sortableChildren = true;
    this.centre(positions);
  }

  private drawFloor(positions: { x: number; y: number }[]): void {
    const { w, h } = floorExtent(positions);
    const g = this.floor;
    g.clear();
    g.zIndex = -1;

    for (let gx = -1; gx < w; gx += 1) {
      for (let gy = -1; gy < h; gy += 1) {
        const p = toScreen(gx, gy);
        g.moveTo(p.x, p.y)
          .lineTo(p.x + TILE_W, p.y + TILE_H)
          .lineTo(p.x, p.y + TILE_H * 2)
          .lineTo(p.x - TILE_W, p.y + TILE_H)
          .closePath()
          .fill({ color: (gx + gy) % 2 === 0 ? 0x111a2e : 0x0e1626 });
      }
    }
  }

  /** Fit the room in view. No free camera in M5 — that is M7 polish. */
  private centre(positions: { x: number; y: number }[]): void {
    if (!this.app) return;
    const { w, h } = floorExtent(positions);
    const width = this.app.screen.width;
    const height = this.app.screen.height;

    const roomW = (w + h) * TILE_W;
    const roomH = (w + h) * TILE_H;
    const scale = Math.min(1, (width * 0.9) / roomW, (height * 0.85) / roomH);

    this.world.scale.set(scale);
    this.world.position.set(
      width / 2 + ((h - w) / 2) * TILE_W * scale,
      height / 2 - ((w + h) / 2) * TILE_H * scale + TILE_H * scale,
    );
  }
}
