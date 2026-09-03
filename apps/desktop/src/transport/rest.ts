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

/**
 * How long to wait before trying a read again when the backend was not there.
 *
 * The dev launcher restarts the backend when a `.py` file changes, and it comes
 * back on the same port a second or so later. Without this, an edit while the
 * app is open shows up as a wall of errors for something that fixed itself.
 */
const RESTART_GRACE_MS = 900;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiBase, token } = requireHandshake();

  const send = () =>
    fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Studio-Token": token,
        ...(init.headers ?? {}),
      },
    });

  let res: Response;
  try {
    res = await send();
  } catch (first) {
    // Only a read is retried. A write that failed at the network level may
    // still have been delivered and acted on — the response is what went
    // missing, not necessarily the request — and launching two missions
    // because one reply was lost is worse than an error message.
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET") {
      await sleep(RESTART_GRACE_MS);
      try {
        res = await send();
        return await unwrap<T>(res);
      } catch {
        // Fall through to the message below: it was not a restart.
      }
    }
    const cause = first;
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

  return unwrap<T>(res);
}

async function unwrap<T>(res: Response): Promise<T> {
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
  /** What a search endpoint last said about its own allowance, measured at
   *  `verifiedAt`. **Null means it reports none** — Tavily sends no such
   *  header — and null must never be drawn as zero (§1.1). */
  quota: QuotaWindow[] | null;
}

/** One allowance an endpoint declared. An endpoint can declare several at once:
 *  Brave sends a per-second cap and a per-month one together, and `windowSec`
 *  is what tells them apart. */
export interface QuotaWindow {
  limit: number;
  remaining: number;
  /** Null when the endpoint stated a total and never said over what period —
   *  Tavily's `/usage` does exactly that. Not a zero, and not a month. */
  windowSec: number | null;
  resetSec: number | null;
  /** What is being counted, plural. Brave meters requests; Tavily meters
   *  credits, where a search is one and a crawl is not. */
  unit: string;
}

/** A starting point for the add-a-model form: a base URL and whether a key is
 *  usually wanted. Deliberately carries no model ids — those have a live answer
 *  and a shipped list would go stale in silence. */
export interface ModelPreset {
  id: string;
  name: string;
  kind: "openai_compatible" | "anthropic";
  baseUrl: string | null;
  needsKey: boolean;
  /** A server on this machine. Shown differently because the failure it is
   *  likely to hit is "nothing is listening", not "wrong key". */
  local: boolean;
}

export interface BudgetLimits {
  max_tokens: number;
  max_llm_calls: number;
  max_supersteps: number;
  timeout_sec: number;
}

export interface StoragePart {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  bytes: number;
  files: number;
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
      modelPresets: ModelPreset[];
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

  /** The ceilings every run starts from (§10). This app's own limits, not the
   *  endpoint's — nothing here is imposed by the provider. */
  budget: () =>
    request<{
      value: BudgetLimits;
      shipped: BudgetLimits;
      bounds: Record<keyof BudgetLimits, [number, number]>;
    }>("/prefs/budget"),

  setBudget: (value: BudgetLimits) =>
    request<{
      value: BudgetLimits;
      shipped: BudgetLimits;
      bounds: Record<keyof BudgetLimits, [number, number]>;
    }>("/prefs/budget", { method: "PUT", body: JSON.stringify(value) }),

  /** Where the runs, the produced files and the attachments actually live. */
  storage: () =>
    request<{ root: string; parts: StoragePart[] }>("/storage"),

  /** The model ids an endpoint actually offers, asked before anything is saved.
   *  A POST because the key travels in the body: a key must never go in a URL
   *  (§9.1). Nothing here is stored — `error` is the endpoint's own words when
   *  it could not answer, so the form can fall back to a text field. */
  endpointModels: (body: {
    kind: "openai_compatible" | "anthropic";
    base_url: string | null;
    key: string | null;
  }) =>
    request<{ models: string[]; error: string | null }>("/providers/models", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** The whole search fallback chain, in the order to try it. Sent as one list
   *  rather than a position per row: a position is a statement about the
   *  others, and two half-applied moves would leave the runner reading a table
   *  where two keys claim the same place. */
  setSearchOrder: (ids: string[]) =>
    request<{ ids: string[] }>("/providers/search-order", {
      method: "POST",
      body: JSON.stringify({ ids }),
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
    /** What to call this run in the list. The instruction is `content`. */
    title?: string | null;
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

  /** Staff a team for a brief, from the agents that already exist. Saves
   *  nothing — the proposal is shown to be edited (§11). */
  suggestTeam: (body: { provider_id: string; brief: string }) =>
    request<SuggestResult>("/teams/suggest", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Read a team against a piece of work. Advisory: it returns remarks and
   *  never a severity, and the gate's own findings come back beside them. */
  reviewTeam: (
    teamId: string,
    body: {
      provider_id: string;
      brief: string;
      members?: { agent_id: string; seat_index: number; role_in_team: string }[];
    },
  ) =>
    request<TeamReview>(`/teams/${teamId}/review`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** What this team's last few runs cost and how they ended. Not a forecast —
   *  there is no honest way to estimate a run, and this is the record. */
  teamHistory: (teamId: string, limit = 5) =>
    request<{ runs: TeamRun[] }>(`/teams/${teamId}/history?limit=${limit}`),

  /** Every version of one file in a run, oldest first — the order a diff
   *  walks: each against the one before it. */
  fileVersions: (missionId: string, path: string) =>
    request<{ versions: FileVersion[] }>(
      `/missions/${missionId}/file-versions?path=${encodeURIComponent(path)}`,
    ),

  readFileVersion: (versionId: string) =>
    request<FileVersion & { text: string }>(`/file-versions/${versionId}`),

  // ---- history and artifacts ---------------------------------------------

  listMissions: (limit = 50) =>
    request<{ missions: MissionSummary[] }>(`/missions?limit=${limit}`),


  /** Keep a finished run going in the same conversation (§7.1). The roster,
   *  the workspace and the whole timeline carry over. */
  continueMission: (
    missionId: string,
    content: string,
    /** Show the plan and wait, for this round. It could only ever be asked for
     *  at launch before, so seeing the plan first was a thing you got once per
     *  conversation — while the plan is the one point where stopping still
     *  saves the cost of the work. */
    opts: { requireApproval?: boolean } = {},
  ) =>
    request<{ missionId: string; continued: boolean }>(
      `/missions/${missionId}/continue`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          require_approval: opts.requireApproval ?? false,
        }),
      },
    ),

  /** Branch a run: same frozen roster, same workspace, a separate log. */
  forkMission: (
    missionId: string,
    content: string,
    opts: { title?: string; requireApproval?: boolean } = {},
  ) =>
    request<{ missionId: string; forkedFrom: string }>(
      `/missions/${missionId}/fork`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          title: opts.title ?? null,
          require_approval: opts.requireApproval ?? false,
        }),
      },
    ),

  /** What a rewind would do — asked before it does any of it, because it can
   *  only restore what `write_file` and `edit_file` wrote. */
  rewindPlan: (missionId: string, seq: number) =>
    request<RewindPlan>(`/missions/${missionId}/rewind?seq=${seq}`),

  rewind: (missionId: string, seq: number) =>
    request<{ seq: number; restored: string[]; skipped: RewindFile[] }>(
      `/missions/${missionId}/rewind`,
      { method: "POST", body: JSON.stringify({ seq }) },
    ),

  /** Attach an image to a run. Every agent on the next round sees it. */
  addAttachment: (
    missionId: string,
    body: { name: string; mime: string; data_b64: string },
  ) =>
    request<{ attachmentId: string; name: string; bytes: number; mime: string }>(
      `/missions/${missionId}/attachments`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /**
   * Fetch an attached image back as an object URL.
   *
   * Not a plain `<img src>`: the session token is a header, not a query
   * parameter, and putting it in a URL would leak it into anything that logs
   * one (§9.1). So the bytes are fetched with the header like every other
   * request and wrapped in a blob the browser can render.
   *
   * The caller owns the URL and must revoke it — an object URL that is never
   * released holds the image in memory for the life of the page.
   */
  readAttachmentUrl: async (attachmentId: string): Promise<string> => {
    const { apiBase, token } = requireHandshake();
    const res = await fetch(`${apiBase}/attachments/${attachmentId}`, {
      headers: { "X-Agent-Studio-Token": token },
    });
    if (!res.ok) throw new ApiError(res.status, `attachment ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },

  /** Run one command in a mission's workspace, as the user (§2.7).
   *
   *  Not an agent action: no approval gate, and nothing written to the
   *  mission log. `cwd` travels both ways so `cd` persists between calls. */
  runCommand: (
    missionId: string,
    body: { command: string; cwd?: string | null },
  ) =>
    request<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      cwd: string;
      durationMs: number;
      timedOut: boolean;
      truncated: boolean;
    }>(`/missions/${missionId}/terminal`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  terminalInfo: (missionId: string) =>
    request<{ workspaceRoot: string | null; shellAvailable: boolean }>(
      `/missions/${missionId}/terminal`,
    ),

  /** When a tool call stops to ask. One value for the whole app (§16.4). */
  getAutonomy: () =>
    request<{ value: string; choices: string[] }>("/prefs/autonomy"),

  setAutonomy: (value: string) =>
    request<{ value: string; choices: string[] }>("/prefs/autonomy", {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),

  /** Say something to a team that is already working (§7.1).
   *
   *  Queued, not delivered: nothing can reach a model mid-reply, so the note
   *  waits in each member's mailbox until their next task starts. 409 means
   *  the run ended while the message was being typed. */
  noteMission: (missionId: string, content: string, to: string | null = null) =>
    request<{ missionId: string; queued: boolean }>(
      `/missions/${missionId}/message`,
      { method: "POST", body: JSON.stringify({ content, to }) },
    ),

  /** The replay source: the append-only log, exactly as it was written. */
  missionEvents: (missionId: string) =>
    request<{ events: unknown[] }>(`/missions/${missionId}/events`),

  /** Delete a whole run: its row, its events and its files. The one exception
   *  to the append-only rule, and only ever whole missions (§2, §5). */
  deleteMission: (missionId: string) =>
    request<void>(`/missions/${missionId}`, { method: "DELETE" }),

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

  /** Really delete. Safe for replays — a mission keeps its own copy of who ran
   *  it (§5.1) — but the agent's team seats go with it. */
  deleteAgent: (id: string) =>
    request<void>(`/agents/${id}/permanent`, { method: "DELETE" }),

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

  deleteTeam: (id: string) =>
    request<void>(`/teams/${id}/permanent`, { method: "DELETE" }),

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
  /** Null for every run recorded before migration 0010; those are listed by
   *  their goal, which is what they were named at the time. */
  title: string | null;
  goal: string;
  status: string;
  endReason: string | null;
  /** Which of the four ceilings, when `endReason` is `budget_exceeded`.
   *  Null on a run recorded before the column existed. */
  endLimit?: string | null;
  /** How far through its plan the latest round got. Null on a run recorded
   *  before the columns existed — the number could only be recovered by
   *  reading its whole log, which is what the columns exist to avoid. */
  tasksDone?: number | null;
  tasksTotal?: number | null;
  startedAt: string;
  endedAt: string | null;
  pendingRequest: string | null;
  memberCount: number;
  /** Whether *this* backend process is running it. A mission from a previous
   *  launch is history even if its row still looks recent. */
  running: boolean;
}

export interface ProposedMember {
  agentId: string;
  seat: number;
  role: "leader" | "worker";
  /** Tools this person is missing and the work needs. Empty is the usual
   *  answer, and the right one for somebody already equipped. */
  addTools: string[];
  why: string;
}

export interface ProposedGap {
  role: string;
  why: string;
  tools: string[];
}

export interface TeamProposal {
  layoutId: string;
  members: ProposedMember[];
  /** Roles the work needs that nobody on the roster can fill. */
  gaps: ProposedGap[];
}

export interface SuggestResult {
  proposal: TeamProposal;
  /** What the *run gate* says about what the model proposed — never the
   *  model's opinion of itself. Kept under its own key all the way to the
   *  screen, because a rule and an opinion are different claims (§5.2). */
  findings: Finding[];
  canRun: boolean;
  attempts: number;
  recoveredFrom: string[];
}

export interface ReviewNote {
  about: string;
  /** One of a closed set; anything unrecognised arrives as "note" (§8). */
  kind: "missing_tool" | "wrong_fit" | "gap" | "risk" | "note";
  message: string;
}

export interface TeamReview {
  verdict: string;
  notes: ReviewNote[];
  findings: Finding[];
  canRun: boolean;
  attempts: number;
  recoveredFrom: string[];
}

export interface RewindFile {
  path: string;
  versionId: string | null;
  /** "restore" | "created_after" | "missing_blob" | "unchanged" | "failed".
   *  Read as a closed set here and rendered by name, so a kind this build has
   *  not heard of is shown rather than dropped (§8). */
  action: string;
  bytes: number | null;
}

export interface RewindPlan {
  seq: number;
  files: RewindFile[];
  willChange: number;
}

export interface TeamRun {
  id: string;
  title: string | null;
  endReason: string | null;
  endLimit: string | null;
  tokens: number;
  tasksDone: number | null;
  tasksTotal: number | null;
  startedAt: string;
}

export interface FileVersion {
  id: string;
  missionId: string;
  path: string;
  sha256: string;
  bytes: number;
  lines: number;
  agentId: string | null;
  eventId: string;
  createdAt: string;
}

export interface Artifact {
  id: string;
  missionId: string;
  agentId: string | null;
  title: string;
  path: string;
  kind: string;
  /** "workspace" for a file an agent wrote into the folder this run was given
   *  — it is still there and still editable; "store" for one the app wrote
   *  under its own artifact root. Absent on rows recorded before the two were
   *  distinguished, which were all of the second kind (§8). */
  source?: string;
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
  /** Tool ids the model chose, checked against the registry on the way back
   *  (§16.1). Empty is a real answer. */
  tools: string[];
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

