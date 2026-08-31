"""Test connection: find out what an endpoint does by asking it to do it.

PROJECT_BRIEF.md §3.1 — "supports tool calling" in a vendor's docs is not the
same claim as "this model, at this base_url, on this key, returns a well-formed
tool call". So every capability recorded here was observed, and each of the four
checks reports separately: a failure at step 1 (wrong model id) and a failure at
step 3 (no tool calling) need completely different fixes from the user, and a
single red cross would hide which one happened.

**A check has three outcomes, not two.** `inconclusive` exists because the first
version of this file recorded a capability the endpoint never demonstrated: a
128-token cap truncated the reply mid-string, the JSON failed to parse, and the
model was written down as unable to produce JSON. It could — it had spent 137
tokens on reasoning before emitting any content. A truncated stream is evidence
of nothing, and evidence of nothing must never reach the database.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

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
    was_truncated,
)

CheckStatus = Literal["pass", "fail", "inconclusive"]

#: Generous on purpose. `max_tokens` is a cap, not a spend — a reasoning model
#: can burn well over a hundred tokens before its first visible character, and a
#: cap tight enough to cut that off turns every probe into a false negative.
PROBE_MAX_TOKENS = 2048

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

_TRUNCATED_DETAIL = (
    "the reply was cut off at max_tokens before it finished, so this proves "
    "nothing either way — not recorded"
)


@dataclass
class CheckResult:
    id: str
    label: str
    status: CheckStatus
    detail: str

    @property
    def ok(self) -> bool:
        return self.status == "pass"

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "status": self.status,
            "ok": self.ok,
            "detail": self.detail,
        }


@dataclass
class ProbeResult:
    checks: list[CheckResult] = field(default_factory=list)
    capabilities: Capabilities = field(default_factory=Capabilities)
    usage: Usage = field(default_factory=Usage)
    #: Capability fields this run actually established. Anything absent was not
    #: demonstrated and must not be written to the profile (§3.1).
    conclusive: set[str] = field(default_factory=set)

    @property
    def ok(self) -> bool:
        """Whether the endpoint is usable at all.

        Steps 1 and 2 are pass/fail for the endpoint as a whole. Steps 3 and 4
        are informational: a model without tool calling still works for chat,
        the UI just has to warn before an agent is given tools.
        """
        required = {"models", "chat"}
        return all(c.ok for c in self.checks if c.id in required)

    @property
    def counts(self) -> dict[str, int]:
        return {
            "passed": sum(1 for c in self.checks if c.status == "pass"),
            "failed": sum(1 for c in self.checks if c.status == "fail"),
            "inconclusive": sum(1 for c in self.checks if c.status == "inconclusive"),
            "total": len(self.checks),
        }

    def conclusive_capabilities(self) -> dict[str, Any]:
        """Only the fields this run proved. The caller merges these onto what
        is already stored rather than replacing it wholesale."""
        full = self.capabilities.to_json()
        return {k: v for k, v in full.items() if k in self.conclusive}

    def to_json(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "counts": self.counts,
            "checks": [c.to_json() for c in self.checks],
            "capabilities": self.capabilities.to_json(),
            "conclusive": sorted(self.conclusive),
        }


async def _collect(
    provider: LLMProvider, req: ChatRequest, caps: Capabilities
) -> tuple[str, list[ToolCallChunk], DoneChunk | None]:
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

    # ---- 1. does this model id exist here? ----------------------------
    # First, because every later failure is ambiguous until this is settled:
    # a typo'd id looks exactly like a broken endpoint.
    try:
        models = await provider.list_models()
        if model in models:
            result.checks.append(
                CheckResult("models", "Model exists", "pass", f"{len(models)} models offered")
            )
        else:
            close = [m for m in models if model.split("-")[0] in m][:5]
            result.checks.append(
                CheckResult(
                    "models",
                    "Model exists",
                    "fail",
                    f"{model!r} is not offered here."
                    + (f" Did you mean: {', '.join(close)}?" if close else ""),
                )
            )
            return result
    except ProviderError as exc:
        result.checks.append(CheckResult("models", "Model exists", "fail", exc.message))
        return result

    # ---- 2. plain chat, streamed, and does it accept sampling? --------
    sampling_supported = True
    try:
        text, _, done = await _chat_probe(provider, model, sampling=True)
    except ProviderError:
        # Sonnet 5 removed temperature/top_p/top_k and 400s on them, so a
        # failure here may be about the parameter rather than the endpoint.
        # Retry once without sampling before blaming the connection.
        try:
            text, _, done = await _chat_probe(provider, model, sampling=False)
            sampling_supported = False
        except ProviderError as retry_exc:
            result.checks.append(
                CheckResult("chat", "Chat and streaming", "fail", retry_exc.message)
            )
            return result

    if done:
        result.usage = done.usage
    if not text.strip():
        result.checks.append(
            CheckResult(
                "chat",
                "Chat and streaming",
                "fail",
                "the endpoint streamed no text at all",
            )
        )
        return result

    result.checks.append(
        CheckResult(
            "chat",
            "Chat and streaming",
            "pass",
            f"replied {text.strip()[:40]!r}"
            + ("" if sampling_supported else " (model rejects sampling parameters, "
               "so temperature will be ignored)"),
        )
    )
    # Established either way: it accepted the parameter, or it rejected it and
    # the retry succeeded. Both are observations.
    result.conclusive.add("sampling_params")

    # ---- 3. tool calling ----------------------------------------------
    tool_calling = False
    try:
        _, calls, done = await _collect(
            provider,
            ChatRequest(
                model=model,
                messages=[Message("user", "Report that everything is fine.")],
                max_tokens=PROBE_MAX_TOKENS,
                tools=[_PROBE_TOOL],
            ),
            Capabilities(sampling_params=sampling_supported, tool_calling=True),
        )
        stop = done.stop_reason if done else None
        wanted = [c for c in calls if c.name == _PROBE_TOOL.name]

        if was_truncated(stop) and not wanted:
            # The arguments would be a fragment even if a call had appeared.
            result.checks.append(
                CheckResult("tools", "Tool calling", "inconclusive", _TRUNCATED_DETAIL)
            )
        elif any(c.truncated for c in wanted):
            result.checks.append(
                CheckResult(
                    "tools",
                    "Tool calling",
                    "inconclusive",
                    "a tool call started but its arguments were cut off at "
                    "max_tokens, so they cannot be trusted — not recorded",
                )
            )
        else:
            tool_calling = bool(wanted)
            result.conclusive.add("tool_calling")
            result.checks.append(
                CheckResult(
                    "tools",
                    "Tool calling",
                    "pass" if tool_calling else "fail",
                    "returned a well-formed tool call"
                    if tool_calling
                    else "accepted the tool but answered in prose instead of calling it",
                )
            )
    except ProviderError as exc:
        # A refusal from the endpoint is a real answer about the endpoint.
        result.conclusive.add("tool_calling")
        result.checks.append(CheckResult("tools", "Tool calling", "fail", exc.message))

    # ---- 4. structured output, strongest mode first --------------------
    structured: str = "none"
    status: CheckStatus = "fail"
    detail = "no structured-output mode worked"
    conclusive = True

    for mode in ("schema", "json_object"):
        try:
            text, _, done = await _collect(
                provider,
                ChatRequest(
                    model=model,
                    messages=[
                        Message(
                            "user",
                            'Reply with JSON matching {"ok": boolean, "note": string}.',
                        )
                    ],
                    max_tokens=PROBE_MAX_TOKENS,
                    response_schema=_PROBE_SCHEMA,
                ),
                Capabilities(
                    sampling_params=sampling_supported,
                    tool_calling=tool_calling,
                    structured_output=mode,  # type: ignore[arg-type]
                ),
            )

            if was_truncated(done.stop_reason if done else None):
                # This is the exact failure the three-outcome design exists for.
                detail, conclusive, status = _TRUNCATED_DETAIL, False, "inconclusive"
                break

            parsed = json.loads(text)
            if not isinstance(parsed, dict) or "ok" not in parsed:
                raise ValueError("the reply was JSON but not the requested shape")

            structured, status, conclusive = mode, "pass", True
            detail = (
                "schema is enforced by the endpoint"
                if mode == "schema"
                else "JSON mode only — the shape is not enforced, so replies must "
                "be validated and retried by the caller"
            )
            break
        except ProviderError as exc:
            # An explicit rejection is a real answer: this mode is unavailable.
            detail = exc.message
        except (json.JSONDecodeError, ValueError) as exc:
            detail = f"reply was not usable JSON: {exc}"

    result.checks.append(CheckResult("structured", "Structured output", status, detail))
    if conclusive:
        result.conclusive.add("structured_output")

    max_in = max_out = None
    describe = getattr(provider, "describe_model", None)
    if describe is not None:
        try:
            info = await describe(model)
            max_in, max_out = info.get("max_input_tokens"), info.get("max_output_tokens")
            result.conclusive.update({"max_input_tokens", "max_output_tokens"})
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


async def _chat_probe(provider: LLMProvider, model: str, *, sampling: bool):
    return await _collect(
        provider,
        ChatRequest(
            model=model,
            messages=[Message("user", "Reply with the single word: ready")],
            max_tokens=PROBE_MAX_TOKENS,
            sampling={"temperature": 0.0} if sampling else None,
        ),
        Capabilities(sampling_params=sampling),
    )
