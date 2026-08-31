"""Anthropic via the `anthropic` SDK (PROJECT_BRIEF.md §3.1).

**Never route this through an OpenAI-compatible shim.** The wire shapes differ
in ways that fail quietly rather than loudly: `system` is a top-level parameter
and not a message, thinking blocks and `tool_use` blocks have no counterpart in
the chat-completions schema, cache read and cache write are reported as separate
counters, and `stop_reason` carries values (`refusal`, `pause_turn`) that a shim
flattens away. A shim would appear to work and would silently lose all of it.

Model-shape differences handled here, all driven by `Capabilities` rather than
by a model-name check:

* `temperature` / `top_p` / `top_k` were removed on Sonnet 5 — sending one is a
  400. Haiku 4.5 still accepts them.
* Extended thinking is `{"type": "adaptive"}` on current models but the older
  `{"type": "enabled", "budget_tokens": N}` on Haiku 4.5.
* `output_config.effort` exists on Sonnet 5 and errors on Haiku 4.5.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

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


class AnthropicProvider:
    kind = "anthropic"

    def __init__(self, *, api_key: str, base_url: str | None = None) -> None:
        self._client = AsyncAnthropic(api_key=api_key, base_url=base_url)

    async def list_models(self) -> list[str]:
        try:
            page = await self._client.models.list()
            return sorted(m.id for m in page.data)
        except Exception as exc:
            raise _normalise(exc) from exc

    async def describe_model(self, model: str) -> dict[str, Any]:
        """Live capability lookup, so context limits are read rather than guessed."""
        try:
            info = await self._client.models.retrieve(model)
        except Exception as exc:
            raise _normalise(exc) from exc
        return {
            "max_input_tokens": getattr(info, "max_input_tokens", None),
            "max_output_tokens": getattr(info, "max_tokens", None),
            "capabilities": getattr(info, "capabilities", None),
        }

    async def stream(
        self, req: ChatRequest, caps: Capabilities
    ) -> AsyncIterator[Chunk]:
        sampling, notices = apply_sampling(req.sampling, caps)
        for notice in notices:
            yield notice

        kwargs: dict[str, Any] = {
            "model": req.model,
            "messages": [{"role": m.role, "content": m.content} for m in req.messages],
            "max_tokens": req.max_tokens,
            **sampling,
        }
        # System is a top-level parameter, not a message in the list.
        if req.system:
            kwargs["system"] = req.system

        if req.tools and caps.tool_calling:
            kwargs["tools"] = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                    # Guarantees tool_use.input validates against the schema
                    # instead of merely resembling it.
                    "strict": True,
                }
                for t in req.tools
            ]
        elif req.tools:
            yield NoticeChunk(
                code="tools_unsupported",
                message="model did not pass the tool-calling probe; tools omitted",
            )

        if req.response_schema:
            if caps.structured_output == "schema":
                # output_config.format — not the deprecated `output_format`.
                kwargs["output_config"] = {
                    "format": {
                        "type": "json_schema",
                        "schema": req.response_schema,
                    }
                }
            else:
                yield NoticeChunk(
                    code="structured_output_unsupported",
                    message="model did not pass the structured-output probe",
                )

        usage = Usage()
        stop_reason: str | None = None
        tool_blocks: dict[int, dict[str, str]] = {}

        try:
            async with self._client.messages.stream(**kwargs) as stream:
                async for event in stream:
                    kind = getattr(event, "type", None)

                    if kind == "message_start":
                        usage = _merge_usage(usage, getattr(event.message, "usage", None))

                    elif kind == "content_block_start":
                        block = event.content_block
                        if getattr(block, "type", None) == "tool_use":
                            tool_blocks[event.index] = {
                                "id": block.id,
                                "name": block.name,
                                "arguments": "",
                            }

                    elif kind == "content_block_delta":
                        delta = event.delta
                        dtype = getattr(delta, "type", None)
                        if dtype == "text_delta":
                            yield TextChunk(delta.text)
                        elif dtype == "input_json_delta":
                            slot = tool_blocks.get(event.index)
                            if slot is not None:
                                slot["arguments"] += delta.partial_json

                    elif kind == "message_delta":
                        stop_reason = getattr(event.delta, "stop_reason", None) or stop_reason
                        usage = _merge_usage(usage, getattr(event, "usage", None))

                final = await stream.get_final_message()
                stop_reason = final.stop_reason or stop_reason
                usage = _merge_usage(usage, final.usage)

                # A refusal is HTTP 200 with an empty-ish body. Checked
                # explicitly, because reading content without checking makes it
                # look like the model simply had nothing to say.
                if final.stop_reason == "refusal":
                    details = getattr(final, "stop_details", None)
                    yield NoticeChunk(
                        code="provider_refusal",
                        message="the model declined this request"
                        + (f" ({details.category})" if getattr(details, "category", None) else ""),
                        recoverable=False,
                    )
        except Exception as exc:
            raise _normalise(exc) from exc

        # input_json_delta arrives in fragments, so a cut-off stream leaves a
        # half-written arguments object. Flagged, never passed on as complete.
        truncated = was_truncated(stop_reason)
        for slot in tool_blocks.values():
            yield ToolCallChunk(
                call_id=slot["id"],
                name=slot["name"],
                arguments_json=slot["arguments"] or "{}",
                truncated=truncated,
            )

        yield DoneChunk(stop_reason=stop_reason, usage=usage)

    async def aclose(self) -> None:
        await self._client.close()


def _merge_usage(current: Usage, raw: Any) -> Usage:
    """Usage arrives in pieces: input at message_start, output at message_delta.

    Cache creation and cache read stay in their own counters the whole way —
    they are billed at different rates, so a sum here is unrecoverable later.
    """
    if raw is None:
        return current
    return Usage(
        input_tokens=int(getattr(raw, "input_tokens", 0) or 0) or current.input_tokens,
        output_tokens=int(getattr(raw, "output_tokens", 0) or 0) or current.output_tokens,
        cache_read_tokens=int(getattr(raw, "cache_read_input_tokens", 0) or 0)
        or current.cache_read_tokens,
        cache_write_tokens=int(getattr(raw, "cache_creation_input_tokens", 0) or 0)
        or current.cache_write_tokens,
    )


def _normalise(exc: Exception) -> ProviderError:
    if isinstance(exc, anthropic.AuthenticationError):
        return ProviderError("provider_auth", "API key rejected by Anthropic")
    if isinstance(exc, anthropic.RateLimitError):
        return ProviderError("provider_rate_limit", "rate limited", recoverable=True)
    if isinstance(exc, anthropic.APIConnectionError):
        return ProviderError(
            "provider_unreachable", "could not reach Anthropic", recoverable=True
        )
    if isinstance(exc, anthropic.APIStatusError):
        return ProviderError(
            f"provider_{exc.status_code}",
            f"Anthropic returned {exc.status_code}: {exc.message}",
            recoverable=exc.status_code >= 500,
        )
    return ProviderError("provider_error", str(exc))
