"""Test connection: find out what an endpoint does by asking it to do it.

PROJECT_BRIEF.md §3.1 — "supports tool calling" in a vendor's docs is not the
same claim as "this model, at this base_url, on this key, returns a well-formed
tool call". So every capability recorded here was observed, and each of the four
checks reports separately: a failure at step 1 (wrong model id) and a failure at
step 3 (no tool calling) need completely different fixes from the user, and a
single red cross would hide which one happened.

Kept deliberately cheap — tiny prompts, small `max_tokens`. Running this costs
a fraction of a cent.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    LLMProvider,
    Message,
    ProviderError,
    TextChunk,
    ToolCallChunk,
    ToolSpec,
    Usage,
)

_PROBE_TOOL = ToolSpec(
    name="report_status",
    description="Report a one-word status. Call this tool; do not answer in prose.",
    parameters={
        "type": "object",
        "properties": {"status": {"type": "string"}},
        "required": ["status"],
        "additionalProperties": False,
    },
)

_PROBE_SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}, "note": {"type": "string"}},
    "required": ["ok", "note"],
    "additionalProperties": False,
}


@dataclass
class CheckResult:
    id: str
    label: str
    ok: bool
    detail: str

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "ok": self.ok, "detail": self.detail}


@dataclass
class ProbeResult:
    checks: list[CheckResult] = field(default_factory=list)
    capabilities: Capabilities = field(default_factory=Capabilities)
    usage: Usage = field(default_factory=Usage)

    @property
    def ok(self) -> bool:
        """Steps 1 and 2 are pass/fail for the endpoint as a whole. Steps 3 and 4
        are informational: a model without tool calling is still usable for chat,
        the UI just has to warn before an agent is given tools."""
        required = {"models", "chat"}
        return all(c.ok for c in self.checks if c.id in required)

    def to_json(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "checks": [c.to_json() for c in self.checks],
            "capabilities": self.capabilities.to_json(),
        }


async def _collect(provider: LLMProvider, req: ChatRequest, caps: Capabilities):
    text, tool_calls, done = [], [], None
    async for chunk in provider.stream(req, caps):
        if isinstance(chunk, TextChunk):
            text.append(chunk.text)
        elif isinstance(chunk, ToolCallChunk):
            tool_calls.append(chunk)
        elif isinstance(chunk, DoneChunk):
            done = chunk
    return "".join(text), tool_calls, done


async def run_probe(provider: LLMProvider, model: str) -> ProbeResult:
    result = ProbeResult()
    caps = Capabilities()

    # ---- 1. does this model id exist here? ----------------------------
    # First, because every later failure is ambiguous until this is settled:
    # a typo'd id looks exactly like a broken endpoint.
    try:
        models = await provider.list_models()
        if model in models:
            result.checks.append(
                CheckResult("models", "Model exists", True, f"{len(models)} models offered")
            )
        else:
            close = [m for m in models if model.split("-")[0] in m][:5]
            result.checks.append(
                CheckResult(
                    "models",
                    "Model exists",
                    False,
                    f"{model!r} is not offered here."
                    + (f" Did you mean: {', '.join(close)}?" if close else ""),
                )
            )
            return result
    except ProviderError as exc:
        result.checks.append(CheckResult("models", "Model exists", False, exc.message))
        return result

    # ---- 2. plain chat, streamed, and does it accept sampling? --------
    sampling_supported = True
    try:
        text, _, done = await _collect(
            provider,
            ChatRequest(
                model=model,
                messages=[Message("user", "Reply with the single word: ready")],
                max_tokens=16,
                sampling={"temperature": 0.0},
            ),
            Capabilities(sampling_params=True),
        )
        result.checks.append(
            CheckResult("chat", "Chat and streaming", True, f"replied {text.strip()!r}")
        )
        if done:
            result.usage = done.usage
    except ProviderError as exc:
        # Sonnet 5 removed temperature/top_p/top_k and 400s on them, so a
        # failure here may be about the parameter rather than the endpoint.
        # Retry once without sampling before blaming the connection.
        try:
            text, _, done = await _collect(
                provider,
                ChatRequest(
                    model=model,
                    messages=[Message("user", "Reply with the single word: ready")],
                    max_tokens=16,
                ),
                Capabilities(sampling_params=False),
            )
            sampling_supported = False
            result.checks.append(
                CheckResult(
                    "chat",
                    "Chat and streaming",
                    True,
                    f"replied {text.strip()!r} (model rejects sampling parameters, "
                    "so temperature will be ignored)",
                )
            )
            if done:
                result.usage = done.usage
        except ProviderError as retry_exc:
            result.checks.append(
                CheckResult("chat", "Chat and streaming", False, retry_exc.message)
            )
            return result

    caps = Capabilities(sampling_params=sampling_supported)

    # ---- 3. tool calling ----------------------------------------------
    tool_calling = False
    try:
        _, calls, _ = await _collect(
            provider,
            ChatRequest(
                model=model,
                messages=[Message("user", "Report that everything is fine.")],
                max_tokens=256,
                tools=[_PROBE_TOOL],
            ),
            Capabilities(sampling_params=sampling_supported, tool_calling=True),
        )
        tool_calling = any(c.name == _PROBE_TOOL.name for c in calls)
        result.checks.append(
            CheckResult(
                "tools",
                "Tool calling",
                tool_calling,
                "returned a well-formed tool call"
                if tool_calling
                else "accepted the tool but answered in prose instead of calling it",
            )
        )
    except ProviderError as exc:
        result.checks.append(CheckResult("tools", "Tool calling", False, exc.message))

    # ---- 4. structured output, strongest mode first --------------------
    structured = "none"
    detail = ""
    for mode in ("schema", "json_object"):
        try:
            text, _, _ = await _collect(
                provider,
                ChatRequest(
                    model=model,
                    messages=[
                        Message(
                            "user",
                            'Reply with JSON matching {"ok": boolean, "note": string}.',
                        )
                    ],
                    max_tokens=128,
                    response_schema=_PROBE_SCHEMA,
                ),
                Capabilities(
                    sampling_params=sampling_supported,
                    tool_calling=tool_calling,
                    structured_output=mode,
                ),
            )
            parsed = json.loads(text)
            if not isinstance(parsed, dict) or "ok" not in parsed:
                raise ValueError("JSON did not match the requested shape")
            structured = mode
            detail = (
                "schema is enforced by the endpoint"
                if mode == "schema"
                else "JSON mode only — the shape is not enforced, so replies must "
                "be validated and retried by the caller"
            )
            break
        except (ProviderError, json.JSONDecodeError, ValueError) as exc:
            detail = str(getattr(exc, "message", exc))

    result.checks.append(
        CheckResult(
            "structured",
            "Structured output",
            structured != "none",
            detail or "no structured-output mode worked",
        )
    )

    max_in = max_out = None
    describe = getattr(provider, "describe_model", None)
    if describe is not None:
        try:
            info = await describe(model)
            max_in, max_out = info.get("max_input_tokens"), info.get("max_output_tokens")
        except ProviderError:
            pass  # optional enrichment; never fails the probe

    result.capabilities = Capabilities(
        tool_calling=tool_calling,
        structured_output=structured,  # type: ignore[arg-type]
        vision=False,  # not probed in M1; no image path exists yet
        sampling_params=sampling_supported,
        thinking="none",
        effort=False,
        max_input_tokens=max_in,
        max_output_tokens=max_out,
    )
    return result
