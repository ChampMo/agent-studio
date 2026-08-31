"""OpenAI-compatible endpoints: DeepSeek (the dev default), Ollama, LM Studio,
vLLM, OpenRouter, LiteLLM, Groq, Together (PROJECT_BRIEF.md §3.1).

Uses the `openai` SDK pointed at `base_url`. Never the `anthropic` SDK, and
never the reverse — see the note in anthropic_provider.py.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from openai import (
    APIConnectionError,
    APIStatusError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)

from .base import (
    Capabilities,
    ChatRequest,
    Chunk,
    DoneChunk,
    NoticeChunk,
    ProviderError,
    TextChunk,
    ToolCallChunk,
    Usage,
    apply_sampling,
    was_truncated,
)


class OpenAICompatibleProvider:
    kind = "openai_compatible"

    def __init__(self, *, api_key: str, base_url: str | None = None) -> None:
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def list_models(self) -> list[str]:
        try:
            page = await self._client.models.list()
            return sorted(m.id for m in page.data)
        except Exception as exc:
            raise _normalise(exc) from exc

    async def stream(
        self, req: ChatRequest, caps: Capabilities
    ) -> AsyncIterator[Chunk]:
        sampling, notices = apply_sampling(req.sampling, caps)
        for notice in notices:
            yield notice

        kwargs: dict[str, Any] = {
            "model": req.model,
            "messages": _messages(req),
            "max_tokens": req.max_tokens,
            "stream": True,
            # Without this, an OpenAI-compatible stream reports no usage at all
            # and the budget guard runs blind for the whole call.
            "stream_options": {"include_usage": True},
            **sampling,
        }
        if req.tools and caps.tool_calling:
            kwargs["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in req.tools
            ]
        elif req.tools:
            yield NoticeChunk(
                code="tools_unsupported",
                message="endpoint did not pass the tool-calling probe; tools omitted",
            )

        if req.response_schema:
            fmt, notice = _response_format(req.response_schema, caps)
            if fmt:
                kwargs["response_format"] = fmt
            if notice:
                yield notice

        # Tool calls arrive as fragments spread across deltas, keyed by index.
        partial: dict[int, dict[str, str]] = {}
        usage = Usage()
        stop_reason: str | None = None

        try:
            stream = await self._client.chat.completions.create(**kwargs)
            async for event in stream:
                if event.usage:
                    usage = _usage(event.usage)
                if not event.choices:
                    continue
                choice = event.choices[0]
                if choice.finish_reason:
                    stop_reason = choice.finish_reason

                delta = choice.delta
                if delta is None:
                    continue
                if delta.content:
                    yield TextChunk(delta.content)
                for tc in delta.tool_calls or []:
                    slot = partial.setdefault(
                        tc.index, {"id": "", "name": "", "arguments": ""}
                    )
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["arguments"] += tc.function.arguments
        except Exception as exc:
            raise _normalise(exc) from exc

        # Tool arguments arrive as fragments keyed by index, so a stream that
        # was cut off leaves a half-written JSON object here. Flagged rather
        # than silently handed on as a complete call.
        truncated = was_truncated(stop_reason)
        for slot in partial.values():
            if slot["name"]:
                yield ToolCallChunk(
                    call_id=slot["id"] or slot["name"],
                    name=slot["name"],
                    arguments_json=slot["arguments"] or "{}",
                    truncated=truncated,
                )

        yield DoneChunk(stop_reason=stop_reason, usage=usage)

    async def aclose(self) -> None:
        await self._client.close()


def _messages(req: ChatRequest) -> list[dict[str, str]]:
    """System is a message here, unlike Anthropic where it is a top-level field."""
    out = [{"role": "system", "content": req.system}] if req.system else []
    out.extend({"role": m.role, "content": m.content} for m in req.messages)
    return out


def _response_format(
    schema: dict[str, Any], caps: Capabilities
) -> tuple[dict[str, Any] | None, NoticeChunk | None]:
    """Pick the strongest structured-output mode the endpoint actually has.

    The two modes are not interchangeable: `json_object` asks for valid JSON and
    nothing more, while `json_schema` + `strict` enforces the shape. Plenty of
    OpenAI-compatible endpoints only have the former, which is why profile_gen
    validates and retries regardless of what is reported here (§3.1).
    """
    if caps.structured_output == "schema":
        return {
            "type": "json_schema",
            "json_schema": {"name": "response", "schema": schema, "strict": True},
        }, None
    if caps.structured_output == "json_object":
        return {"type": "json_object"}, NoticeChunk(
            code="schema_not_enforced",
            message="endpoint supports JSON mode but not schema enforcement; "
            "the reply must be validated by the caller",
        )
    return None, NoticeChunk(
        code="structured_output_unsupported",
        message="endpoint did not pass the structured-output probe",
    )


def _usage(raw: Any) -> Usage:
    details = getattr(raw, "prompt_tokens_details", None)
    cached = int(getattr(details, "cached_tokens", 0) or 0) if details else 0
    prompt = int(getattr(raw, "prompt_tokens", 0) or 0)
    return Usage(
        # `prompt_tokens` includes the cached portion, so subtract it out to
        # keep "input" meaning what it means everywhere else: uncached input.
        input_tokens=max(0, prompt - cached),
        output_tokens=int(getattr(raw, "completion_tokens", 0) or 0),
        cache_read_tokens=cached,
    )


def _normalise(exc: Exception) -> ProviderError:
    """One error vocabulary, so the UI can react to a class of failure rather
    than string-matching an SDK's message."""
    if isinstance(exc, AuthenticationError):
        return ProviderError("provider_auth", "API key rejected by the endpoint")
    if isinstance(exc, RateLimitError):
        return ProviderError(
            "provider_rate_limit", "rate limited by the endpoint", recoverable=True
        )
    if isinstance(exc, APIConnectionError):
        return ProviderError(
            "provider_unreachable",
            "could not reach the endpoint; check base_url and the network",
            recoverable=True,
        )
    if isinstance(exc, APIStatusError):
        return ProviderError(
            f"provider_{exc.status_code}",
            f"endpoint returned {exc.status_code}: {exc.message}",
            recoverable=exc.status_code >= 500,
        )
    return ProviderError("provider_error", str(exc))
