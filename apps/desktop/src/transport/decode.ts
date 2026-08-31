/**
 * The one place raw socket frames become typed events.
 *
 * PROJECT_BRIEF.md §8 makes forward compatibility a hard constraint: mission_events
 * is append-only forever, so a build from today will one day read rows written by a
 * newer build. Every unknown value has to degrade rather than throw — an unknown event
 * type becomes a fallback row, an unknown status becomes the default pose, an unknown
 * enum becomes a neutral value.
 *
 * A pure function on purpose. That is what lets the rule be a test rather than a
 * comment, without any component test infrastructure (§13).
 */
import schema from "@shared/events.schema.json";
import type {
  EphemeralFrame,
  EventEnvelope,
  PayloadAgentStatus,
} from "./events.generated";

/** The schema version this build was generated against. */
export const KNOWN_SCHEMA_VERSION = 1;

/**
 * Event types this build understands, read out of the contract itself rather than
 * copied into a list here. A hand-kept list is a second source of truth, and it would
 * drift the first time someone adds an event type (§2.2).
 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = (() => {
  const defs = (schema as any).$defs ?? {};
  const refs: string[] = (defs.EventDraft?.oneOf ?? []).map((r: any) => r.$ref ?? "");
  const types = refs
    .map((ref) => defs[ref.split("/").pop() ?? ""]?.properties?.type?.const)
    .filter((t: unknown): t is string => typeof t === "string");
  return new Set(types);
})();

export const AGENT_POSES = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
] as const;
export type AgentPose = (typeof AGENT_POSES)[number];

/** What the scene falls back to for a status it has no animation for (§8). */
export const DEFAULT_POSE: AgentPose = "idle";

export type Decoded =
  | { kind: "sequenced"; event: EventEnvelope; known: boolean; futureVersion: boolean }
  | { kind: "ephemeral"; frame: EphemeralFrame }
  | { kind: "malformed"; raw: unknown; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise an agent status.
 *
 * The scene's animation state machine has a finite set of poses. When the backend
 * grows a sixth status, an unhandled value must not leave a sprite in an undefined
 * state or throw inside a render — it falls back (§8).
 */
export function toPose(status: unknown): AgentPose {
  return AGENT_POSES.includes(status as AgentPose) ? (status as AgentPose) : DEFAULT_POSE;
}

/** Narrow an enum-ish field, with an explicit neutral fallback. Never throws. */
export function toEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Decode one frame off the socket.
 *
 * Returns a variant for every outcome instead of throwing: a single bad frame must
 * never be able to tear down a live stream.
 */
export function decodeFrame(raw: unknown): Decoded {
  if (!isRecord(raw)) return { kind: "malformed", raw, reason: "frame is not an object" };

  // Ephemeral first: deltas have no seq at all, so testing for seq would
  // misclassify them as malformed (§7.1).
  if (raw.channel === "ephemeral") {
    if (typeof raw.messageId !== "string" || typeof raw.text !== "string") {
      return { kind: "malformed", raw, reason: "ephemeral frame is missing messageId or text" };
    }
    return { kind: "ephemeral", frame: raw as unknown as EphemeralFrame };
  }

  if (typeof raw.seq !== "number" || typeof raw.id !== "string") {
    return { kind: "malformed", raw, reason: "envelope is missing id or seq" };
  }
  if (!isRecord(raw.draft) || typeof raw.draft.type !== "string") {
    return { kind: "malformed", raw, reason: "envelope is missing draft.type" };
  }

  return {
    kind: "sequenced",
    event: raw as unknown as EventEnvelope,
    // Unknown but structurally valid: the timeline shows a fallback row rather
    // than dropping a real thing that happened.
    known: KNOWN_EVENT_TYPES.has(raw.draft.type),
    // A newer writer. The known fields still render; nothing is discarded.
    futureVersion: typeof raw.v === "number" && raw.v > KNOWN_SCHEMA_VERSION,
  };
}

/** The status carried by an `agent.status` event, already normalised. */
export function poseFromEvent(event: EventEnvelope): AgentPose | null {
  if (event.draft.type !== "agent.status") return null;
  return toPose((event.draft.payload as PayloadAgentStatus).status);
}

/**
 * A readable line for any event, including ones this build has never heard of.
 * Falling back to the raw type keeps an unknown event legible instead of blank.
 *
 * `nameOf` resolves an agent id to the name recorded in the mission's frozen
 * roster. Without it the log prints opaque ids; with the live roster instead of
 * the snapshot, a replay would print today's names for yesterday's work (§5.1).
 */
export function describe(
  event: EventEnvelope,
  nameOf: (agentId: string) => string = (id) => id,
): string {
  const { type, payload } = event.draft;
  const p = payload as Record<string, any>;
  const who = (id: unknown) => (typeof id === "string" ? nameOf(id) : "someone");
  switch (type) {
    case "mission.started":
      return `Mission started — ${p.goal ?? ""}`;
    case "mission.ended":
      return `Mission ended (${p.reason ?? "unknown"}) — ${p.summary ?? ""}`;
    case "mission.progress":
      return `${p.label ?? p.taskId} — ${p.state} ${p.done}/${p.total}`;
    case "agent.status":
      return `${who(p.agentId)} is ${p.status}`;
    case "agent.thought":
      return `${who(p.agentId)} thinking: ${p.text}`;
    case "agent.message":
      return p.agentId ? `${who(p.agentId)}: ${p.content ?? ""}` : (p.content ?? "");
    case "user.message":
      return p.content ?? "";
    case "agent.tool.start":
      return `${who(p.agentId)} calls ${p.tool}`;
    case "agent.tool.end":
      return `${p.tool ?? "tool"} ${p.ok ? "ok" : "failed"} — ${p.summary ?? ""}`;
    case "agent.request":
      return `${who(p.agentId)} asks: ${p.question}`;
    case "agent.request.resolved":
      return `answered (${p.resolvedBy}): ${p.answer}`;
    case "artifact.created":
      return `artifact ${p.kind}: ${p.path}`;
    case "budget.warning":
      return `budget warning — ${p.kind} at ${p.used}/${p.limit}`;
    case "error":
      return `error [${p.code}] ${p.message}`;
    default:
      return type;
  }
}
