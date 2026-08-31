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

Role = Literal["system", "user", "assistant"]
StructuredOutput = Literal["schema", "json_object", "none"]
ThinkingStyle = Literal["adaptive", "budget", "none"]


@dataclass(frozen=True)
class Message:
    role: Role
    content: str


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


@dataclass(frozen=True)
class ToolCallChunk:
    call_id: str
    name: str
    arguments_json: str


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


Chunk = TextChunk | ToolCallChunk | NoticeChunk | DoneChunk


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
