/**
 * The pose vocabulary and its state machine (PROJECT_BRIEF.md §4 `scene/animation`).
 *
 * Pure, so the §8 rule can be a test rather than something you check by looking
 * at the screen: **an unrecognised status becomes the default pose and never
 * throws.** The backend is free to grow a sixth `agent.status` value, and a
 * build that predates it must still draw something sensible.
 *
 * What a pose is allowed to express: posture, and whether the character is
 * turned toward their desk. Nothing here reports a number. No health, no
 * energy, no level — the scene shows what the event stream says is happening
 * and nothing else (§1.1).
 */
import { toPose, type AgentPose, DEFAULT_POSE } from "../../transport/decode";

export type { AgentPose };
export { DEFAULT_POSE };

/** How a character is drawn for each pose. Values are relative, not units. */
export interface PoseShape {
  /** Forward lean toward the desk. Negative leans back. */
  lean: number;
  /** Vertical bob amplitude; 0 is perfectly still. */
  bob: number;
  /** Head tilt in radians. */
  headTilt: number;
  /** Shoulder drop — the visual difference between waiting and blocked. */
  slump: number;
  /** Whether the character faces their desk or the room. */
  facing: "desk" | "room";
  /** A short label drawn under the character. The truth, in words. */
  caption: string;
}

const SHAPES: Record<AgentPose, PoseShape> = {
  idle: { lean: 0, bob: 0.6, headTilt: 0, slump: 0, facing: "room", caption: "idle" },
  thinking: {
    lean: -0.08,
    bob: 0.3,
    headTilt: -0.18,
    slump: 0,
    facing: "room",
    caption: "thinking",
  },
  working: {
    lean: 0.22,
    bob: 1.4,
    headTilt: 0.12,
    slump: 0,
    facing: "desk",
    caption: "working",
  },
  waiting: {
    lean: -0.05,
    bob: 0.2,
    headTilt: 0.05,
    slump: 0.15,
    facing: "room",
    caption: "waiting",
  },
  blocked: {
    lean: 0,
    bob: 0,
    headTilt: 0.25,
    slump: 0.5,
    facing: "room",
    caption: "blocked",
  },
};

/**
 * The pose for a status, whatever the status turns out to be.
 *
 * Delegates the narrowing to `toPose`, which is the same function the timeline
 * uses — one place decides what a known status is, so the two views cannot
 * disagree about it.
 */
export function poseFor(status: unknown): AgentPose {
  return toPose(status);
}

export function shapeFor(pose: AgentPose): PoseShape {
  // Indexed by a value `poseFor` already narrowed, but defended anyway: this is
  // the last function between a stray string and a renderer that would draw
  // `undefined` (§8).
  return SHAPES[pose] ?? SHAPES[DEFAULT_POSE];
}

/** Poses that mean the character is doing something right now. */
export function isActive(pose: AgentPose): boolean {
  return pose === "thinking" || pose === "working";
}
