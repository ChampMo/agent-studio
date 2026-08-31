/**
 * Typed REST client. Every request carries the session token (§9.1).
 *
 * Note what is missing: there is no way to read a provider key back. The
 * backend has no such endpoint, and this client could not call one if it did.
 */
import { requireHandshake } from "./handshake";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiBase, token } = requireHandshake();
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Studio-Token": token,
      ...(init.headers ?? {}),
    },
  });

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
  kind: "openai_compatible" | "anthropic";
  baseUrl: string | null;
  model: string;
  capabilities: Capabilities | null;
  verifiedAt: string | null;
  /** Whether a key exists in the OS keychain. Never the key itself. */
  hasKey: boolean;
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
    request<{ providers: ProviderProfile[]; kinds: string[] }>("/providers"),

  createProvider: (body: {
    name: string;
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
    body: { name?: string; model?: string; base_url?: string | null },
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

  cancelMission: (id: string) =>
    request<{ missionId: string; cancelled: boolean }>(`/missions/${id}/cancel`, {
      method: "POST",
    }),

  getMission: (id: string) => request<Record<string, unknown>>(`/missions/${id}`),

  listTools: () => request<{ tools: unknown[] }>("/tools"),

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
};

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
  avatarConfig: AvatarConfig;
  totalMissions: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derived from exp by the backend; there is no level column (§5). */
  level: number;
  exp: number;
  into_level: number;
  level_span: number;
}
