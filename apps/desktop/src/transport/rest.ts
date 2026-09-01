/**
 * Typed REST client. Every request carries the session token (§9.1).
 *
 * Note what is missing: there is no way to read a provider key back. The
 * backend has no such endpoint, and this client could not call one if it did.
 */
import { requireHandshake } from "./handshake";

export class ApiError extends Error {
  /** `0` when the request never reached the backend at all. */
  constructor(
    public status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiBase, token } = requireHandshake();

  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Studio-Token": token,
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    // A network-level failure, not an HTTP one. On this app it means one thing
    // in practice: this page was loaded against a backend that is no longer
    // there. The port and token are injected at page load and the dev launcher
    // takes a fresh port every start, so a tab left open across a restart keeps
    // calling an address nobody is listening on — and the browser's own words
    // for that are "Failed to fetch", which say nothing about what to do.
    throw new ApiError(
      0,
      `The backend is not reachable at ${apiBase}. If it was restarted, reload ` +
        "this page — the port and session token are handed to the page when it loads.",
      { cause },
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      // A non-JSON error body is still an error; keep the status text.
    }
    throw new ApiError(res.status, detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// ---- provider profiles -------------------------------------------------

export interface ProviderProfile {
  id: string;
  name: string;
  /** "search" is not a model endpoint: nothing runs on it, it only makes
   *  `web_search` available (§16.5). */
  kind: "openai_compatible" | "anthropic" | "search";
  baseUrl: string | null;
  model: string;
  capabilities: Capabilities | null;
  verifiedAt: string | null;
  /** Whether a key exists in the OS keychain. Never the key itself. */
  hasKey: boolean;
  /** The endpoint searches the web itself during a completion (§16.8). This
   *  app never sees the call: no approval, no redaction, opaque results. */
  nativeSearch: boolean;
  /** Whether this endpoint is one that can do that at all. */
  nativeSearchAvailable: boolean;
}

export interface Capabilities {
  tool_calling: boolean;
  structured_output: "schema" | "json_object" | "none";
  vision: boolean;
  sampling_params: boolean;
  thinking: "adaptive" | "budget" | "none";
  effort: boolean;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
}

export type CheckStatus = "pass" | "fail" | "inconclusive";

export interface ProbeCheck {
  id: string;
  label: string;
  /** Three outcomes, not two: see `inconclusive` in probe.py. */
  status: CheckStatus;
  ok: boolean;
  detail: string;
}

export interface ProbeCounts {
  passed: number;
  failed: number;
  inconclusive: number;
  total: number;
}

export interface ProbeResult {
  /** Whether the endpoint is usable at all — models + chat only. NOT "all
   *  checks passed": tool calling and structured output are informational. */
  ok: boolean;
  counts: ProbeCounts;
  checks: ProbeCheck[];
  capabilities: Capabilities;
  /** Capability fields this run actually established and stored. */
  conclusive: string[];
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/health"),

  listProviders: () =>
    request<{
      providers: ProviderProfile[];
      kinds: string[];
      searchEngines: SearchEngine[];
    }>("/providers"),

  createProvider: (body: {
    name: string;
    /** "openai_compatible" | "anthropic" | "search" (§16.5). */
    kind: string;
    model: string;
    base_url?: string | null;
  }) =>
    request<ProviderProfile>("/providers", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateProvider: (
    id: string,
    body: {
      name?: string;
      model?: string;
      base_url?: string | null;
      native_search?: boolean;
    },
  ) =>
    request<ProviderProfile>(`/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteProvider: (id: string) =>
    request<void>(`/providers/${id}`, { method: "DELETE" }),

  /** Write-only by design: the key goes to the keychain and never comes back. */
  setKey: (id: string, key: string) =>
    request<void>(`/providers/${id}/key`, {
      method: "PUT",
      body: JSON.stringify({ key }),
    }),

  clearKey: (id: string) =>
    request<void>(`/providers/${id}/key`, { method: "DELETE" }),

  testConnection: (id: string) =>
    request<ProbeResult>(`/providers/${id}/test`, { method: "POST" }),

  startChat: (body: {
    provider_id: string;
    content: string;
    system?: string | null;
    budget?: Record<string, number>;
  }) =>
    request<{ missionId: string; sinceSeq: number }>("/missions", {
      method: "POST",
      body: JSON.stringify({ kind: "chat", ...body }),
    }),

  /** Launch a team. Rejected with 409 and every blocking finding when the
   *  team cannot run — the same findings the builder showed (§5.2). */
  startMission: (body: {
    team_id: string;
    content: string;
    budget?: Record<string, number>;
    /** Stop after planning and wait for the user before any of it is paid for. */
    require_approval?: boolean;
    /** The folder this mission's file tools may touch (§16.2). */
    workspace_root?: string | null;
  }) =>
    request<{ missionId: string; sinceSeq: number }>("/missions", {
      method: "POST",
      body: JSON.stringify({ kind: "mission", ...body }),
    }),

  cancelMission: (id: string) =>
    request<{ missionId: string; cancelled: boolean }>(`/missions/${id}/cancel`, {
      method: "POST",
    }),

  getMission: (id: string) => request<Record<string, unknown>>(`/missions/${id}`),

  listTools: () => request<{ tools: Tool[] }>("/tools"),

  // ---- workspace (§16.2) -------------------------------------------------

  /** Resolve and check a chosen folder. Validation is the backend's, always:
   *  the path comes from a window, and a window can be driven. */
  validateWorkspace: (path: string) =>
    request<WorkspaceCheck>("/workspaces/validate", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  recentWorkspaces: () =>
    request<{ workspaces: RecentWorkspace[] }>("/workspaces/recent"),

  // ---- waiting on a person (§12 M6) --------------------------------------

  /** What is waiting for an answer, across every mission.
   *
   *  Asked for on startup, not only when an event arrives: the question may
   *  have been published in a session that has since been closed, and a client
   *  that only listened would leave that mission stranded. */
  pendingRequests: () =>
    request<{ requests: PendingRequest[] }>("/requests/pending"),

  resolveRequest: (requestId: string, answer: string) =>
    request<{ missionId: string; resumed: boolean }>(
      `/requests/${requestId}/resolve`,
      { method: "POST", body: JSON.stringify({ answer }) },
    ),

  // ---- history and artifacts ---------------------------------------------

  listMissions: (limit = 50) =>
    request<{ missions: MissionSummary[] }>(`/missions?limit=${limit}`),

  /** The replay source: the append-only log, exactly as it was written. */
  missionEvents: (missionId: string) =>
    request<{ events: unknown[] }>(`/missions/${missionId}/events`),

  missionArtifacts: (missionId: string) =>
    request<{ artifacts: Artifact[] }>(`/missions/${missionId}/artifacts`),

  readArtifact: (artifactId: string) =>
    request<Artifact & { text: string }>(`/artifacts/${artifactId}`),

  // ---- roster ----------------------------------------------------------

  avatarAssets: () => request<{ slots: Record<string, string[]> }>("/avatar-assets"),

  listAgents: (includeArchived = false) =>
    request<{ agents: Agent[] }>(`/agents?include_archived=${includeArchived}`),

  createAgent: (body: AgentInput) =>
    request<Agent>("/agents", { method: "POST", body: JSON.stringify(body) }),

  updateAgent: (id: string, body: Partial<AgentInput>) =>
    request<Agent>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  duplicateAgent: (id: string) =>
    request<Agent>(`/agents/${id}/duplicate`, { method: "POST" }),

  /** Archive, not delete: teams and finished missions still point at the row. */
  archiveAgent: (id: string) => request<Agent>(`/agents/${id}`, { method: "DELETE" }),

  restoreAgent: (id: string) =>
    request<Agent>(`/agents/${id}/restore`, { method: "POST" }),

  /** Drafts a profile and returns it. Saves nothing: the user edits first. */
  generateAgent: (body: { provider_id: string; role: string; brief?: string }) =>
    request<GenerateResult>("/agents/generate", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ---- teams -----------------------------------------------------------

  sceneLayouts: () =>
    request<{ layouts: SceneLayout[]; default: string }>("/scene-layouts"),

  listTeams: (includeArchived = false) =>
    request<{ teams: Team[] }>(`/teams?include_archived=${includeArchived}`),

  getTeam: (id: string) => request<Team>(`/teams/${id}`),

  createTeam: (body: TeamInput) =>
    request<Team>("/teams", { method: "POST", body: JSON.stringify(body) }),

  updateTeam: (id: string, body: Partial<TeamInput>) =>
    request<Team>(`/teams/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  duplicateTeam: (id: string) =>
    request<Team>(`/teams/${id}/duplicate`, { method: "POST" }),

  archiveTeam: (id: string) => request<Team>(`/teams/${id}`, { method: "DELETE" }),

  restoreTeam: (id: string) =>
    request<Team>(`/teams/${id}/restore`, { method: "POST" }),

  exportTeam: (id: string) => request<TeamExport>(`/teams/${id}/export`),

  importTeam: (document: TeamExport) =>
    request<{ team_id: string; agent_ids: string[]; alreadyImported: string[]; team: Team }>(
      "/teams/import",
      { method: "POST", body: JSON.stringify(document) },
    ),
};

// ---- tools and workspace types ------------------------------------------

export type ToolRisk = "safe" | "guarded" | "dangerous";

export interface Tool {
  id: string;
  title: string;
  description: string;
  /** What it takes to stop and ask before running (§16.4). */
  risk: ToolRisk;
  /** Unmet requirements keep a tool out of this list entirely, except
   *  `workspace`, which is a per-mission choice. */
  requires: string[];
  redactFields: string[];
  truncateResultBytes: number;
  inputSchema: Record<string, unknown>;
}

export interface SearchEngine {
  id: string;
  name: string;
  /** The base URL that identifies this engine to the backend (§16.5). */
  baseUrl: string;
}

export interface WorkspaceWarning {
  code: string;
  message: string;
}

export interface WorkspaceCheck {
  /** The resolved path — what the backend will actually use. */
  path: string;
  warnings: WorkspaceWarning[];
}

export interface RecentWorkspace {
  path: string;
  lastUsedAt: string;
  /** False when the folder has been moved or deleted since it was used. */
  exists: boolean;
}

// ---- waiting, history and artifact types --------------------------------

export interface PendingRequest {
  missionId: string;
  requestId: string;
  goal: string;
  askedAt: string;
  question?: string;
  kind?: "question" | "approval";
  options?: string[] | null;
  agentId?: string | null;
}

export interface MissionSummary {
  id: string;
  kind: string;
  goal: string;
  status: string;
  endReason: string | null;
  startedAt: string;
  endedAt: string | null;
  pendingRequest: string | null;
  memberCount: number;
  /** Whether *this* backend process is running it. A mission from a previous
   *  launch is history even if its row still looks recent. */
  running: boolean;
}

export interface Artifact {
  id: string;
  missionId: string;
  agentId: string | null;
  title: string;
  path: string;
  kind: string;
  bytes: number;
  createdAt: string;
}

// ---- roster types -------------------------------------------------------

export type AvatarConfig = Record<string, string>;

export interface GeneratedProfile {
  name: string;
  title: string;
  role: string;
  backstory: string;
  personality_traits: string[];
  system_prompt: string;
  avatar_config: AvatarConfig;
}

export interface GenerateResult {
  profile: GeneratedProfile;
  attempts: number;
  /** Problems the generator corrected on the way. Shown, not hidden: a profile
   *  that took three tries says something about the model the user picked. */
  recoveredFrom: string[];
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
}

export type Autonomy = "ask_always" | "ask_dangerous" | "trusted";

export interface AgentInput {
  name: string;
  title?: string;
  role?: string;
  backstory?: string;
  personality_traits?: string[];
  system_prompt?: string;
  provider_id?: string | null;
  model?: string | null;
  sampling?: Record<string, unknown> | null;
  tools?: string[];
  autonomy?: Autonomy;
  avatar_config?: AvatarConfig;
}

export interface Agent {
  id: string;
  name: string;
  title: string;
  role: string;
  backstory: string;
  personalityTraits: string[];
  systemPrompt: string;
  providerId: string | null;
  model: string | null;
  sampling: Record<string, unknown> | null;
  tools: string[];
  /** When this agent's tool calls stop to ask (§16.4). */
  autonomy: Autonomy;
  avatarConfig: AvatarConfig;
  /** Missions that actually finished. A fact, not a score (§1.1). */
  totalMissions: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- team types ---------------------------------------------------------

export interface SceneLayout {
  id: string;
  name: string;
  seats: number;
  description: string;
}

export type Severity = "warn" | "error";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** The member or seat this is about, so the builder can mark it inline. */
  subject: string | null;
}

export interface TeamMember {
  agentId: string;
  seatIndex: number;
  roleInTeam: "leader" | "member";
  overrides: Record<string, unknown> | null;
  agentName: string | null;
  agentArchived: boolean | null;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  emblemConfig: Record<string, unknown>;
  sceneLayoutId: string;
  defaultBudget: Record<string, unknown>;
  sourceId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  members: TeamMember[];
  findings: Finding[];
  /** Computed from `findings` alone — there is no second set of checks (§5.2). */
  canRun: boolean;
}

export interface TeamMemberInput {
  agent_id: string;
  seat_index: number;
  role_in_team: "leader" | "member";
  overrides?: Record<string, unknown> | null;
}

export interface TeamInput {
  name: string;
  description?: string;
  emblem_config?: Record<string, unknown>;
  scene_layout_id?: string;
  default_budget?: Record<string, unknown>;
  members?: TeamMemberInput[];
}

/** Opaque on purpose: the shape belongs to the backend's exporter. */
export type TeamExport = Record<string, unknown>;
