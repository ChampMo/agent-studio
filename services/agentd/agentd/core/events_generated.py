"""GENERATED FILE - DO NOT EDIT.

Source:     packages/shared/events.schema.json
Regenerate: npm run codegen
Verify:     npm run codegen:check

Editing this file by hand breaks the single-contract rule in
PROJECT_BRIEF.md section 2.2, and codegen:check will fail in CI.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, Field, RootModel


class Usage(BaseModel):
    inputTokens: Annotated[
        int, Field(description='Input tokens NOT served from cache.', ge=0)
    ]
    outputTokens: Annotated[int, Field(ge=0)]
    cacheReadTokens: Annotated[
        int | None, Field(description='Served from cache — cheaper than input.', ge=0)
    ] = None
    cacheWriteTokens: Annotated[
        int | None,
        Field(description='Written to cache — more expensive than input.', ge=0),
    ] = None
    costUsd: Annotated[
        float | None,
        Field(
            description='Optional. Leave unset when the model has no entry in pricing.json — never guess.',
            ge=0.0,
        ),
    ] = None


class RecipientAgent(BaseModel):
    kind: Literal['agent']
    id: str


class RecipientUser(BaseModel):
    kind: Literal['user']


class RecipientBroadcast(BaseModel):
    kind: Literal['broadcast']


class Recipient(RootModel[RecipientAgent | RecipientUser | RecipientBroadcast]):
    root: Annotated[
        RecipientAgent | RecipientUser | RecipientBroadcast,
        Field(
            description='An object, not a magic string, so an agent id can never collide with the literal "user" (§6.2).',
            title='Recipient',
        ),
    ]


class ToolError(BaseModel):
    code: Annotated[
        str,
        Field(
            description='Stable machine-readable class, e.g. "timeout", "not_found", "provider_400".'
        ),
    ]
    message: str


class PayloadMissionStarted(BaseModel):
    kind: Literal['chat', 'mission']
    teamId: Annotated[
        str | None,
        Field(description='Absent when kind is "chat" (degenerate mission).'),
    ] = None
    goal: str
    workspaceRoot: Annotated[
        str | None,
        Field(
            description="The folder this mission's file tools are confined to (section 16.2). Absent for a mission launched without one - a chat, or a team with no fs tool. On the log so a replay can say where the work actually happened."
        ),
    ] = None


class PayloadMissionProgress(BaseModel):
    taskId: str
    label: str
    state: Literal['pending', 'running', 'done', 'failed']
    done: Annotated[int, Field(ge=0)]
    total: Annotated[int, Field(ge=0)]


class PayloadMissionEnded(BaseModel):
    reason: Literal['completed', 'failed', 'budget_exceeded', 'cancelled', 'crashed']
    summary: str


class PayloadAgentStatus(BaseModel):
    agentId: str
    status: Annotated[
        Literal['idle', 'thinking', 'working', 'waiting', 'blocked'],
        Field(
            description='The scene MUST fall back to a default pose on an unrecognised value (§8).'
        ),
    ]


class PayloadAgentThought(BaseModel):
    agentId: str
    text: str


class PayloadAgentMessage(BaseModel):
    agentId: str
    messageId: Annotated[
        str, Field(description='Ties this message back to its ephemeral deltas.')
    ]
    to: Recipient
    content: str
    usage: Usage | None = None


class PayloadAgentToolStart(BaseModel):
    agentId: str
    callId: str
    tool: str
    input: Annotated[
        Any,
        Field(
            description='Arbitrary JSON. Redacted and truncated to 8KB by the bus before it ever reaches this field (§9.3).'
        ),
    ]
    truncated: bool | None = None
    origin: Annotated[
        Literal['client', 'provider'] | None,
        Field(
            description="Who ran the tool. `client` means this app did: it was in the registry, it passed the approval gate, and its input was redacted before it was recorded (section 16.1). `provider` means the model's own endpoint ran it server-side and told us afterwards - none of those three apply, and the event is reconstructed from what came back rather than observed as it happened (section 16.8). Absent means client, which is what every event written before this field existed was."
        ),
    ] = None


class PayloadAgentToolEnd(BaseModel):
    agentId: str
    callId: str
    ok: bool
    summary: str
    durationMs: Annotated[int, Field(ge=0)]
    error: ToolError | None = None
    usage: Usage | None = None
    truncated: bool | None = None
    origin: Annotated[
        Literal['client', 'provider'] | None,
        Field(
            description="Who ran the tool. `client` means this app did: it was in the registry, it passed the approval gate, and its input was redacted before it was recorded (section 16.1). `provider` means the model's own endpoint ran it server-side and told us afterwards - none of those three apply, and the event is reconstructed from what came back rather than observed as it happened (section 16.8). Absent means client, which is what every event written before this field existed was."
        ),
    ] = None


class PayloadUserMessage(BaseModel):
    content: str


class PayloadAgentRequest(BaseModel):
    agentId: str
    requestId: str
    kind: Annotated[
        Literal['question', 'approval'],
        Field(
            description='Approval is a kind of request, not a separate event family (§6.2).'
        ),
    ]
    question: str
    options: list[str] | None = None


class PayloadAgentRequestResolved(BaseModel):
    requestId: str
    answer: str
    resolvedBy: Literal['user', 'timeout', 'cancelled']


class PayloadArtifactCreated(BaseModel):
    agentId: str
    artifactId: Annotated[
        str, Field(description='Links this event to the artifacts table row.')
    ]
    path: Annotated[
        str, Field(description='Sandbox-relative. Never an absolute host path.')
    ]
    kind: Literal['code', 'doc', 'image']


class PayloadBudgetWarning(BaseModel):
    kind: Literal['tokens', 'llm_calls', 'supersteps', 'time']
    used: Annotated[float, Field(ge=0.0)]
    limit: Annotated[float, Field(ge=0.0)]


class PayloadError(BaseModel):
    agentId: str | None = None
    code: Annotated[
        str,
        Field(
            description='Stable machine-readable class so the UI can react, e.g. "sampling_dropped", "provider_auth", "provider_rate_limit".'
        ),
    ]
    message: str
    recoverable: bool


class DraftMissionStarted(BaseModel):
    type: Literal['mission.started']
    payload: PayloadMissionStarted


class DraftMissionProgress(BaseModel):
    type: Literal['mission.progress']
    payload: PayloadMissionProgress


class DraftMissionEnded(BaseModel):
    type: Literal['mission.ended']
    payload: PayloadMissionEnded


class DraftAgentStatus(BaseModel):
    type: Literal['agent.status']
    payload: PayloadAgentStatus


class DraftAgentThought(BaseModel):
    type: Literal['agent.thought']
    payload: PayloadAgentThought


class DraftAgentMessage(BaseModel):
    type: Literal['agent.message']
    payload: PayloadAgentMessage


class DraftAgentToolStart(BaseModel):
    type: Literal['agent.tool.start']
    payload: PayloadAgentToolStart


class DraftAgentToolEnd(BaseModel):
    type: Literal['agent.tool.end']
    payload: PayloadAgentToolEnd


class DraftUserMessage(BaseModel):
    type: Literal['user.message']
    payload: PayloadUserMessage


class DraftAgentRequest(BaseModel):
    type: Literal['agent.request']
    payload: PayloadAgentRequest


class DraftAgentRequestResolved(BaseModel):
    type: Literal['agent.request.resolved']
    payload: PayloadAgentRequestResolved


class DraftArtifactCreated(BaseModel):
    type: Literal['artifact.created']
    payload: PayloadArtifactCreated


class DraftBudgetWarning(BaseModel):
    type: Literal['budget.warning']
    payload: PayloadBudgetWarning


class DraftError(BaseModel):
    type: Literal['error']
    payload: PayloadError


class EventDraft(
    RootModel[
        DraftMissionStarted
        | DraftMissionProgress
        | DraftMissionEnded
        | DraftAgentStatus
        | DraftAgentThought
        | DraftAgentMessage
        | DraftAgentToolStart
        | DraftAgentToolEnd
        | DraftUserMessage
        | DraftAgentRequest
        | DraftAgentRequestResolved
        | DraftArtifactCreated
        | DraftBudgetWarning
        | DraftError
    ]
):
    root: Annotated[
        DraftMissionStarted
        | DraftMissionProgress
        | DraftMissionEnded
        | DraftAgentStatus
        | DraftAgentThought
        | DraftAgentMessage
        | DraftAgentToolStart
        | DraftAgentToolEnd
        | DraftUserMessage
        | DraftAgentRequest
        | DraftAgentRequestResolved
        | DraftArtifactCreated
        | DraftBudgetWarning
        | DraftError,
        Field(
            description='What runtime.py yields. The caller — never the runtime — hands this to the bus (§4.1).',
            discriminator='type',
            title='EventDraft',
        ),
    ]


class EventEnvelope(BaseModel):
    v: Annotated[
        int,
        Field(
            description='Schema version. Present since the very first event — the table is append-only forever.',
            ge=1,
        ),
    ]
    id: Annotated[
        str, Field(description='UUID. Clients dedupe on this when resuming (§7.2).')
    ]
    missionId: str
    seq: Annotated[
        int,
        Field(
            description='Gapless per mission. Assigned by the bus alone (§2.3).', ge=1
        ),
    ]
    ts: Annotated[
        AwareDatetime,
        Field(
            description='Stamped by the bus, never by the producer — clocks differ across processes (§2.3).'
        ),
    ]
    draft: EventDraft


class EphemeralFrame(BaseModel):
    channel: Literal['ephemeral']
    type: Literal['agent.message.delta']
    missionId: str
    agentId: str
    messageId: Annotated[
        str,
        Field(
            description='Matches the messageId of the agent.message that will follow.'
        ),
    ]
    index: Annotated[
        int, Field(description='Monotonic within one messageId. Not a seq.', ge=0)
    ]
    text: str


class AgentStudioEvents(RootModel[EventEnvelope | EphemeralFrame]):
    root: Annotated[
        EventEnvelope | EphemeralFrame,
        Field(
            description="THE central contract (PROJECT_BRIEF.md §2.2). TypeScript types and Pydantic models are BOTH generated from this file — never hand-write either side.\n\nThree shapes live here:\n  * EventDraft    — what agents/runtime.py yields. NO seq/ts/id: those belong to the bus alone (§2.3, §4.1).\n  * EventEnvelope — what the bus persists and broadcasts. Maps 1:1 onto the mission_events table.\n  * EphemeralFrame — the delta channel. NOT persisted, NO seq, never enters the bus (§7.1).\n\nForward compatibility (§8): additive changes ONLY — new optional fields, new event types, new enum values. Never remove, never repurpose. `additionalProperties` is deliberately left open so a v(N) producer's extra fields do not break a v(N-1) consumer.",
            title='AgentStudioEvents',
        ),
    ]
