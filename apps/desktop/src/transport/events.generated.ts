/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source:    packages/shared/events.schema.json
 * Regenerate: npm run codegen
 * Verify:     npm run codegen:check
 *
 * Editing this file by hand breaks the single-contract rule in
 * PROJECT_BRIEF.md §2.2, and codegen:check will fail in CI.
 */

/**
 * THE central contract (PROJECT_BRIEF.md §2.2). TypeScript types and Pydantic models are BOTH generated from this file — never hand-write either side.
 *
 * Three shapes live here:
 *   * EventDraft    — what agents/runtime.py yields. NO seq/ts/id: those belong to the bus alone (§2.3, §4.1).
 *   * EventEnvelope — what the bus persists and broadcasts. Maps 1:1 onto the mission_events table.
 *   * EphemeralFrame — the delta channel. NOT persisted, NO seq, never enters the bus (§7.1).
 *
 * Forward compatibility (§8): additive changes ONLY — new optional fields, new event types, new enum values. Never remove, never repurpose. `additionalProperties` is deliberately left open so a v(N) producer's extra fields do not break a v(N-1) consumer.
 */
export type AgentStudioEvents = EventEnvelope | EphemeralFrame;
/**
 * What runtime.py yields. The caller — never the runtime — hands this to the bus (§4.1).
 */
export type EventDraft =
  | DraftMissionStarted
  | DraftMissionProgress
  | DraftMissionEnded
  | DraftAgentStatus
  | DraftAgentThought
  | DraftAgentMessage
  | DraftAgentUsage
  | DraftAgentToolStart
  | DraftAgentToolEnd
  | DraftUserMessage
  | DraftAgentRequest
  | DraftAgentRequestResolved
  | DraftArtifactCreated
  | DraftBudgetWarning
  | DraftError
  | DraftAttachmentAdded;
/**
 * An object, not a magic string, so an agent id can never collide with the literal "user" (§6.2).
 */
export type Recipient = RecipientAgent | RecipientUser | RecipientBroadcast;

/**
 * What the bus persists then broadcasts, in that order (§7.2). Maps 1:1 onto mission_events: the meta fields are columns, draft.type is the `type` column, draft.payload is the `payload` column.
 *
 * The draft is nested rather than flattened on purpose. It makes the §4.1 rule structural instead of conventional — an envelope is exactly the draft the runtime yielded, untouched, plus the five fields only the bus may assign. It is also the only shape both code generators render correctly: flattening via allOf makes datamodel-codegen overwrite the `type` const with the class name, which silently breaks the discriminator.
 */
export interface EventEnvelope {
  /**
   * Schema version. Present since the very first event — the table is append-only forever.
   */
  v: number;
  /**
   * UUID. Clients dedupe on this when resuming (§7.2).
   */
  id: string;
  missionId: string;
  /**
   * Gapless per mission. Assigned by the bus alone (§2.3).
   */
  seq: number;
  /**
   * Stamped by the bus, never by the producer — clocks differ across processes (§2.3).
   */
  ts: string;
  draft: EventDraft;
}
export interface DraftMissionStarted {
  type: "mission.started";
  payload: PayloadMissionStarted;
}
export interface PayloadMissionStarted {
  kind: "chat" | "mission";
  /**
   * Absent when kind is "chat" (degenerate mission).
   */
  teamId?: string;
  goal: string;
  /**
   * The folder this mission's file tools are confined to (section 16.2). Absent for a mission launched without one - a chat, or a team with no fs tool. On the log so a replay can say where the work actually happened.
   */
  workspaceRoot?: string;
  /**
   * The mission this one was forked from: same frozen roster, same workspace, a separate log. On the event rather than only in the title, because a fork whose origin has to be guessed from a name is a fork whose origin is not recorded.
   */
  forkedFrom?: string;
}
export interface DraftMissionProgress {
  type: "mission.progress";
  payload: PayloadMissionProgress;
}
/**
 * Counters, not a percentage — no honest percentage exists for an agent workflow (§15 row 7).
 */
export interface PayloadMissionProgress {
  taskId: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  done: number;
  total: number;
  /**
   * What this task was actually told to do, on the `pending` event that announces it and nowhere else. The plan message renders titles and seats, which is what a person needs to approve a plan and not enough to run a task again: a task that failed could only be retried by re-running the whole round. Bounded by the plan's own task limit.
   */
  instruction?: string;
}
export interface DraftMissionEnded {
  type: "mission.ended";
  payload: PayloadMissionEnded;
}
export interface PayloadMissionEnded {
  reason: "completed" | "failed" | "budget_exceeded" | "cancelled" | "crashed";
  summary: string;
  /**
   * Which ceiling ended the run, when `reason` is budget_exceeded. Four different problems with four different fixes were being rendered as one phrase, and the reason only existed inside the summary prose. Absent for every other reason, and absent on rounds recorded before this field.
   */
  limit?: "tokens" | "llm_calls" | "supersteps" | "time";
}
export interface DraftAgentStatus {
  type: "agent.status";
  payload: PayloadAgentStatus;
}
export interface PayloadAgentStatus {
  agentId: string;
  /**
   * The scene MUST fall back to a default pose on an unrecognised value (§8).
   */
  status: "idle" | "thinking" | "working" | "waiting" | "blocked";
}
export interface DraftAgentThought {
  type: "agent.thought";
  payload: PayloadAgentThought;
}
/**
 * The agent's OWN scratchpad from the ReAct loop — not the model's hidden chain of thought, which most providers do not return (§6.2).
 */
export interface PayloadAgentThought {
  agentId: string;
  text: string;
}
export interface DraftAgentMessage {
  type: "agent.message";
  payload: PayloadAgentMessage;
}
export interface PayloadAgentMessage {
  agentId: string;
  /**
   * Ties this message back to its ephemeral deltas.
   */
  messageId: string;
  to: Recipient;
  content: string;
  usage?: Usage;
}
export interface RecipientAgent {
  kind: "agent";
  id: string;
}
export interface RecipientUser {
  kind: "user";
}
export interface RecipientBroadcast {
  kind: "broadcast";
}
/**
 * Token accounting for one LLM call. cacheRead and cacheWrite are billed at different rates in different directions, so they can never be collapsed into one field (§6.2).
 */
export interface Usage {
  /**
   * Input tokens NOT served from cache.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * Served from cache — cheaper than input.
   */
  cacheReadTokens?: number;
  /**
   * Written to cache — more expensive than input.
   */
  cacheWriteTokens?: number;
  /**
   * Optional. Leave unset when the model has no entry in pricing.json — never guess.
   */
  costUsd?: number;
}
export interface DraftAgentUsage {
  type: "agent.usage";
  payload: PayloadAgentUsage;
}
/**
 * What one model call cost, for a round that produced no message.
 *
 * A round that only asks for tools publishes no `agent.message` — an empty bubble would suggest the agent said nothing when in fact it acted — and the usage used to go with it. The budget guard counted those tokens and the log did not, so a run stopped at 200,000 could show 7,540 on its own timeline (§1). This is the same number, kept.
 */
export interface PayloadAgentUsage {
  agentId: string;
  /**
   * The round this cost belongs to, so it can be matched to the tool calls it paid for.
   */
  messageId: string;
  usage: Usage;
}
export interface DraftAgentToolStart {
  type: "agent.tool.start";
  payload: PayloadAgentToolStart;
}
export interface PayloadAgentToolStart {
  agentId: string;
  callId: string;
  tool: string;
  /**
   * Arbitrary JSON. Redacted and truncated to 8KB by the bus before it ever reaches this field (§9.3).
   */
  input: {
    [k: string]: unknown;
  };
  truncated?: boolean;
  /**
   * Who ran the tool. `client` means this app did: it was in the registry, it passed the approval gate, and its input was redacted before it was recorded (section 16.1). `provider` means the model's own endpoint ran it server-side and told us afterwards - none of those three apply, and the event is reconstructed from what came back rather than observed as it happened (section 16.8). Absent means client, which is what every event written before this field existed was.
   */
  origin?: "client" | "provider";
}
export interface DraftAgentToolEnd {
  type: "agent.tool.end";
  payload: PayloadAgentToolEnd;
}
export interface PayloadAgentToolEnd {
  agentId: string;
  callId: string;
  ok: boolean;
  summary: string;
  durationMs: number;
  error?: ToolError;
  usage?: Usage;
  truncated?: boolean;
  /**
   * Who ran the tool. `client` means this app did: it was in the registry, it passed the approval gate, and its input was redacted before it was recorded (section 16.1). `provider` means the model's own endpoint ran it server-side and told us afterwards - none of those three apply, and the event is reconstructed from what came back rather than observed as it happened (section 16.8). Absent means client, which is what every event written before this field existed was.
   */
  origin?: "client" | "provider";
}
export interface ToolError {
  /**
   * Stable machine-readable class, e.g. "timeout", "not_found", "provider_400".
   */
  code: string;
  message: string;
}
export interface DraftUserMessage {
  type: "user.message";
  payload: PayloadUserMessage;
}
/**
 * The human's own turn. Without this the replay shows agents reacting to nothing.
 */
export interface PayloadUserMessage {
  content: string;
  /**
   * Who the note was addressed to, when it was addressed to one teammate rather than the whole team. The agent id, resolved from the name that was typed. Absent means everybody, which is what a note has always been - so an older event and a broadcast are the same thing, correctly.
   */
  to?: string;
}
export interface DraftAgentRequest {
  type: "agent.request";
  payload: PayloadAgentRequest;
}
export interface PayloadAgentRequest {
  agentId: string;
  requestId: string;
  /**
   * Approval is a kind of request, not a separate event family (§6.2).
   */
  kind: "question" | "approval";
  question: string;
  options?: string[];
}
export interface DraftAgentRequestResolved {
  type: "agent.request.resolved";
  payload: PayloadAgentRequestResolved;
}
export interface PayloadAgentRequestResolved {
  requestId: string;
  answer: string;
  resolvedBy: "user" | "timeout" | "cancelled";
}
export interface DraftArtifactCreated {
  type: "artifact.created";
  payload: PayloadArtifactCreated;
}
export interface PayloadArtifactCreated {
  agentId: string;
  /**
   * Links this event to the artifacts table row.
   */
  artifactId: string;
  /**
   * Sandbox-relative. Never an absolute host path.
   */
  path: string;
  kind: "code" | "doc" | "image";
  /**
   * Where the file is. `store` is one the app wrote under its own artifact root; `workspace` is one an agent wrote into the folder the mission was given, which stays where the user can see it and may be edited again. Absent means `store`, which is what every row recorded before this field was.
   */
  source?: "store" | "workspace";
}
export interface DraftBudgetWarning {
  type: "budget.warning";
  payload: PayloadBudgetWarning;
}
/**
 * Fired once per kind per mission at 80% (§10.1).
 */
export interface PayloadBudgetWarning {
  kind: "tokens" | "llm_calls" | "supersteps" | "time";
  used: number;
  limit: number;
}
export interface DraftError {
  type: "error";
  payload: PayloadError;
}
export interface PayloadError {
  agentId?: string;
  /**
   * Stable machine-readable class so the UI can react, e.g. "sampling_dropped", "provider_auth", "provider_rate_limit".
   */
  code: string;
  message: string;
  recoverable: boolean;
}
export interface DraftAttachmentAdded {
  type: "attachment.added";
  payload: PayloadAttachmentAdded;
}
/**
 * An image the user attached to this round. The bytes are NOT here: mission_events is append-only forever (§9.3), and a handful of screenshots would make the log unreadable and unbounded. What is kept is what a timeline needs in order to say what happened — the name, the size, the type, and a digest that identifies the file without reproducing it.
 */
export interface PayloadAttachmentAdded {
  /**
   * Links this event to the stored file.
   */
  attachmentId: string;
  name: string;
  bytes: number;
  mime: string;
  /**
   * Identifies the file without reproducing it.
   */
  sha256: string;
}
/**
 * The delta channel (§7.1). Never persisted, never given a seq, never routed through the bus — if a delta consumed a seq, a resuming client would see a gap and believe it had missed an event.
 */
export interface EphemeralFrame {
  channel: "ephemeral";
  type: "agent.message.delta";
  missionId: string;
  agentId: string;
  /**
   * Matches the messageId of the agent.message that will follow.
   */
  messageId: string;
  /**
   * Monotonic within one messageId. Not a seq.
   */
  index: number;
  text: string;
}
