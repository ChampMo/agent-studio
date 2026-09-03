"""The provider contract (PROJECT_BRIEF.md §3.1).

Two things this file exists to prevent.

**Provider leakage.** `agents/runtime.py` must never import a concrete provider.
It builds a `ChatRequest`, gets an `AsyncIterator[Chunk]` back, and never learns
whose API answered.

**Assuming every model takes the same request.** It does not, and not only
across vendors: `temperature` is accepted by Haiku 4.5 and rejected outright by
Sonnet 5 — same SDK, same client, 400 on one and not the other. So request
building is driven by `Capabilities`, which is *observed* by the probe rather
than inferred from a provider name. A hardcoded `if kind == "anthropic"` branch
is the bug this design is here to make impossible.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

Role = Literal["system", "user", "assistant", "tool"]
StructuredOutput = Literal["schema", "json_object", "none"]
ThinkingStyle = Literal["adaptive", "budget", "none"]


@dataclass(frozen=True)
class ToolCall:
    """A call the model asked for, as it goes back into the conversation.

    Kept alongside `ToolCallChunk` rather than reusing it: the chunk is what
    came off a stream and may be truncated, this is a finished call that was
    actually made. Conflating them is how a half-parsed call gets replayed to
    the model as though it had happened.
    """

    call_id: str
    name: str
    arguments_json: str


@dataclass(frozen=True)
class ToolOutcome:
    """What a tool returned, on its way back to the model."""

    call_id: str
    name: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class ImagePart:
    """An image travelling with a message.

    Base64 rather than a path: the two APIs want it inline, the file may be
    outside any workspace, and passing a path would make the provider adapter
    read the disk — which is the one thing it must never do.

    `media_type` comes from the caller and is checked there. An adapter that
    guessed from the bytes would be a second place that decides what a file is.
    """

    media_type: str
    data_b64: str


@dataclass(frozen=True)
class Message:
    """One turn of the conversation.

    A tool round trip is two messages: the assistant's, carrying the calls it
    asked for, and one of role `tool` carrying the results. The two APIs write
    that completely differently — OpenAI uses a `tool` role with a
    `tool_call_id`, Anthropic uses a `user` message containing `tool_result`
    blocks — so this stays neutral and each adapter renders it. A shim that
    pretended they were the same shape is exactly what §15 row 17 rules out.
    """

    role: Role
    content: str = ""
    #: Calls this assistant message asked for. Empty for every other role.
    tool_calls: tuple[ToolCall, ...] = ()
    #: Results carried by a `tool` message.
    tool_results: tuple[ToolOutcome, ...] = ()
    #: Images the user attached. Only ever on a `user` message — a model does
    #: not send pictures back, and an adapter should not have to consider it.
    images: tuple[ImagePart, ...] = ()


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class Capabilities:
    """What an endpoint was observed to do, not what its docs claim.

    `max_input_tokens` rather than `context_window`: that is the name the Models
    API uses, and inventing a synonym here guarantees a mismatch later.
    """

    tool_calling: bool = False
    structured_output: StructuredOutput = "none"
    vision: bool = False
    sampling_params: bool = True
    thinking: ThinkingStyle = "none"
    effort: bool = False
    max_input_tokens: int | None = None
    max_output_tokens: int | None = None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict[str, Any] | None) -> Capabilities:
        if not data:
            return cls()
        known = {f for f in cls.__dataclass_fields__}
        # Unknown keys are ignored rather than fatal: a newer build may have
        # probed capabilities this one does not model yet (§8).
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass(frozen=True)
class ChatRequest:
    """What the runtime asks for. What actually goes on the wire is whatever
    `capabilities` permits — the provider drops the rest and says so."""

    model: str
    messages: list[Message]
    max_tokens: int
    system: str | None = None
    tools: list[ToolSpec] | None = None
    #: temperature / top_p / top_k. Dropped, with a notice, where unsupported.
    sampling: dict[str, Any] | None = None
    #: A JSON Schema to constrain the reply, when the endpoint can enforce one.
    response_schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class Usage:
    """Normalised token accounting. Matches the schema's `Usage` exactly.

    Cache reads and writes stay separate all the way through: they are billed at
    different rates in different directions, and mission_events is append-only,
    so a total collapsed here can never be recovered (§6.2).
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def to_event_usage(self, cost_usd: float | None = None) -> dict[str, Any]:
        out: dict[str, Any] = {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
        }
        if self.cache_read_tokens:
            out["cacheReadTokens"] = self.cache_read_tokens
        if self.cache_write_tokens:
            out["cacheWriteTokens"] = self.cache_write_tokens
        if cost_usd is not None:
            out["costUsd"] = cost_usd
        return out


# ---- stream chunks ----------------------------------------------------
# The provider speaks in chunks; only the runtime knows about events. Keeping
# the event schema out of this layer is what lets M4 wrap the runtime in a graph
# node without touching a single provider.


@dataclass(frozen=True)
class TextChunk:
    text: str


#: Stop reasons that mean the model was cut off rather than finished.
#:
#: Anything assembled across a stream — a JSON reply, a tool call's arguments —
#: is a fragment when the stream ends this way. Treating a fragment as the
#: finished article is how a truncation gets misread as a model limitation.
TRUNCATED_STOP_REASONS = frozenset({"length", "max_tokens"})


def was_truncated(stop_reason: str | None) -> bool:
    return stop_reason in TRUNCATED_STOP_REASONS


@dataclass(frozen=True)
class ToolCallChunk:
    call_id: str
    name: str
    arguments_json: str
    #: True when the stream was cut off before the arguments finished. The
    #: fragment is passed on rather than dropped — the caller must be able to
    #: report what happened — but it must never be executed as if complete.
    truncated: bool = False


@dataclass(frozen=True)
class ServerToolChunk:
    """A tool the *endpoint* ran during the completion (§16.8).

    Nothing here was asked for by this app. The provider searched, read what it
    found, and told us afterwards — so this is a report, not a call. It is kept
    as its own chunk type rather than being passed off as a `ToolCallChunk`
    precisely so that nothing downstream can mistake one for the other: a
    `ToolCallChunk` is a request this app may refuse, and this is not.

    `results` counts what came back. The content itself is usually opaque —
    DeepSeek returns `encrypted_content` — so there is nothing truthful to
    record beyond the query and how many results it produced.
    """

    call_id: str
    name: str
    query: str
    results: int


@dataclass(frozen=True)
class NoticeChunk:
    """Something the caller asked for could not be honoured.

    Emitted rather than swallowed: if we silently drop a setting the agent was
    configured with, the timeline shows a run that never happened the way it is
    displayed, and §1 forbids that.
    """

    code: str
    message: str
    recoverable: bool = True


@dataclass(frozen=True)
class DoneChunk:
    stop_reason: str | None
    usage: Usage = field(default_factory=Usage)


Chunk = TextChunk | ToolCallChunk | ServerToolChunk | NoticeChunk | DoneChunk


class ProviderError(RuntimeError):
    """Normalised provider failure, so callers do not catch SDK-specific types."""

    def __init__(self, code: str, message: str, *, recoverable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.recoverable = recoverable


@runtime_checkable
class LLMProvider(Protocol):
    kind: str

    async def list_models(self) -> list[str]:
        """Model ids the endpoint actually offers.

        The reason no model id is hardcoded anywhere: ids drift, get retired,
        and appear in more than one spelling. Ask the endpoint (§3.1).
        """
        ...

    async def stream(
        self, req: ChatRequest, caps: Capabilities
    ) -> AsyncIterator[Chunk]: ...

    async def aclose(self) -> None: ...


def apply_sampling(
    sampling: dict[str, Any] | None, caps: Capabilities
) -> tuple[dict[str, Any], list[NoticeChunk]]:
    """Sampling parameters the endpoint will accept, plus notices for the rest.

    Sonnet 5 removed `temperature`, `top_p` and `top_k`; sending one is a 400,
    not a warning. Dropping them silently would be worse than the 400 though —
    the agent would appear to run with settings it never had.
    """
    if not sampling:
        return {}, []
    if caps.sampling_params:
        return dict(sampling), []
    return {}, [
        NoticeChunk(
            code="sampling_dropped",
            message=(
                f"model does not accept sampling parameters; "
                f"dropped {', '.join(sorted(sampling))}"
            ),
            recoverable=True,
        )
    ]
