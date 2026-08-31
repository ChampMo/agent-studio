"""M1 proof: the provider layer stays vendor-agnostic and never lies about
what it did (PROJECT_BRIEF.md §3.1).

No network. Every check here is about the seam between the runtime and a vendor
SDK — the place where a hardcoded assumption would quietly reappear.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from agentd.providers import registry
from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    Message,
    NoticeChunk,
    ProviderError,
    TextChunk,
    ToolCallChunk,
    Usage,
    apply_sampling,
)
from agentd.providers.openai_compatible import _messages, _response_format, _usage
from agentd.providers.pricing import cost_usd, known_models, pricing_as_of
from agentd.providers.probe import run_probe


# ---- the runtime must not be able to reach a vendor ---------------------


def test_registry_is_the_only_door_to_a_provider():
    assert set(registry.available_kinds()) == {"openai_compatible", "anthropic"}
    built = registry.build("openai_compatible", api_key="k", base_url="http://x")
    assert built.kind == "openai_compatible"


def test_unknown_kind_fails_loudly_and_says_what_is_available():
    with pytest.raises(ProviderError) as exc:
        registry.build("gemini", api_key="k")
    assert exc.value.code == "unknown_provider_kind"
    assert "anthropic" in exc.value.message


def test_no_module_imports_a_provider_directly_except_the_registry():
    """The rule from §3.1, enforced rather than documented. When runtime.py
    lands in M1.3 this test already covers it.

    Parsed rather than grepped: 'openai_compatible' also appears as a stored
    `kind` value in a CHECK constraint, and a substring search would flag that
    as a violation forever.
    """
    banned = {"openai_compatible", "anthropic_provider"}
    pkg = Path(registry.__file__).resolve().parents[1]
    offenders = []

    for path in pkg.rglob("*.py"):
        rel = path.relative_to(pkg).as_posix()
        if rel.startswith("providers/"):
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom):
                tail = (node.module or "").rsplit(".", 1)[-1]
                if tail in banned:
                    offenders.append(f"{rel}: from ...{tail} import ...")
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.rsplit(".", 1)[-1] in banned:
                        offenders.append(f"{rel}: import {alias.name}")

    assert offenders == [], offenders


# ---- capability-driven request building --------------------------------


def test_sampling_is_dropped_with_a_notice_not_silently():
    """Sonnet 5 400s on temperature while Haiku 4.5 accepts it. Dropping the
    parameter is right; dropping it quietly would show a run in the timeline
    that never happened that way (§1)."""
    kept, notices = apply_sampling({"temperature": 0.7}, Capabilities(sampling_params=True))
    assert kept == {"temperature": 0.7} and notices == []

    kept, notices = apply_sampling({"temperature": 0.7}, Capabilities(sampling_params=False))
    assert kept == {}
    assert len(notices) == 1
    assert notices[0].code == "sampling_dropped"
    assert notices[0].recoverable is True
    assert "temperature" in notices[0].message


def test_structured_output_picks_the_strongest_available_mode():
    fmt, notice = _response_format({"type": "object"}, Capabilities(structured_output="schema"))
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["strict"] is True
    assert notice is None

    fmt, notice = _response_format({"type": "object"}, Capabilities(structured_output="json_object"))
    assert fmt == {"type": "json_object"}
    # JSON mode does not enforce the shape, and the caller has to be told.
    assert notice.code == "schema_not_enforced"

    fmt, notice = _response_format({"type": "object"}, Capabilities(structured_output="none"))
    assert fmt is None and notice.code == "structured_output_unsupported"


def test_system_prompt_goes_where_each_api_expects_it():
    """OpenAI-compatible takes system as a message; Anthropic as a top-level
    field. Getting this wrong is the classic shim bug — it does not error, the
    system prompt is just ignored."""
    msgs = _messages(
        ChatRequest(
            model="m", messages=[Message("user", "hi")], max_tokens=10, system="be terse"
        )
    )
    assert msgs[0] == {"role": "system", "content": "be terse"}


# ---- usage normalisation ------------------------------------------------


def test_openai_usage_splits_cached_tokens_out_of_input():
    """`prompt_tokens` includes the cached portion. Left in, cached tokens would
    be billed twice: once at the input rate and once at the cache rate."""

    class Details:
        cached_tokens = 300

    class Raw:
        prompt_tokens = 1000
        completion_tokens = 50
        prompt_tokens_details = Details()

    usage = _usage(Raw())
    assert usage.input_tokens == 700
    assert usage.cache_read_tokens == 300
    assert usage.output_tokens == 50


def test_event_usage_keeps_cache_directions_apart():
    payload = Usage(
        input_tokens=10, output_tokens=20, cache_read_tokens=5, cache_write_tokens=7
    ).to_event_usage(cost_usd=0.001)
    assert payload == {
        "inputTokens": 10,
        "outputTokens": 20,
        "cacheReadTokens": 5,
        "cacheWriteTokens": 7,
        "costUsd": 0.001,
    }


# ---- pricing ------------------------------------------------------------


def test_cost_is_computed_for_a_known_model():
    # 1M input at $1 + 1M output at $5 for Haiku 4.5.
    cost = cost_usd("claude-haiku-4-5", Usage(input_tokens=1_000_000, output_tokens=1_000_000))
    assert cost == pytest.approx(6.0)


def test_cache_reads_are_not_charged_at_the_input_rate():
    read_only = cost_usd("claude-haiku-4-5", Usage(cache_read_tokens=1_000_000))
    input_only = cost_usd("claude-haiku-4-5", Usage(input_tokens=1_000_000))
    assert read_only < input_only
    write_only = cost_usd("claude-haiku-4-5", Usage(cache_write_tokens=1_000_000))
    assert write_only > input_only


def test_unknown_model_yields_no_cost_rather_than_a_guess():
    """A fabricated price in an append-only table reads as fact forever (§6.2)."""
    assert cost_usd("deepseek-v4-flash", Usage(input_tokens=1000, output_tokens=1000)) is None
    assert "deepseek-v4-flash" not in known_models()
    assert pricing_as_of()


# ---- the probe ----------------------------------------------------------


class FakeProvider:
    """Stands in for any endpoint. Also proves the runtime only ever needs the
    protocol — nothing here imports a vendor SDK."""

    kind = "fake"

    def __init__(self, *, models, tool_calls=True, structured="schema", sampling=True):
        self._models = models
        self._tool_calls = tool_calls
        self._structured = structured
        self._sampling = sampling
        self.calls: list[tuple[ChatRequest, Capabilities]] = []

    async def list_models(self):
        return list(self._models)

    async def stream(self, req: ChatRequest, caps: Capabilities):
        self.calls.append((req, caps))
        if req.sampling and not self._sampling:
            raise ProviderError("provider_400", "temperature is not supported")
        if req.tools:
            if self._tool_calls:
                yield ToolCallChunk("c1", "report_status", '{"status":"fine"}')
            else:
                yield TextChunk("everything is fine")
        elif req.response_schema:
            if caps.structured_output == "schema" and self._structured != "schema":
                raise ProviderError("provider_400", "json_schema is not supported")
            if self._structured == "none":
                yield TextChunk("sorry, plain prose")
            else:
                yield TextChunk('{"ok": true, "note": "hi"}')
        else:
            yield TextChunk("ready")
        yield DoneChunk("end_turn", Usage(input_tokens=5, output_tokens=2))

    async def aclose(self):
        return None


async def test_probe_reports_each_check_separately():
    """A wrong model id and a missing tool-calling feature need different fixes
    from the user, so one combined verdict would hide which happened."""
    result = await run_probe(FakeProvider(models=["m1"]), "m1")
    assert [c.id for c in result.checks] == ["models", "chat", "tools", "structured"]
    assert result.ok
    assert result.capabilities.tool_calling is True
    assert result.capabilities.structured_output == "schema"


async def test_probe_stops_at_a_wrong_model_id_and_suggests_alternatives():
    result = await run_probe(
        FakeProvider(models=["deepseek-v4-flash", "deepseek-v4-pro"]), "deepseek-chat"
    )
    assert not result.ok
    assert [c.id for c in result.checks] == ["models"]
    assert "deepseek-v4-flash" in result.checks[0].detail


async def test_probe_detects_a_model_that_rejects_sampling():
    """The Sonnet 5 case: chat works, temperature does not. The endpoint is
    usable and the UI has to say temperature will be ignored."""
    provider = FakeProvider(models=["m1"], sampling=False)
    result = await run_probe(provider, "m1")
    assert result.ok
    assert result.capabilities.sampling_params is False
    assert "sampling" in dict((c.id, c.detail) for c in result.checks)["chat"]


async def test_probe_falls_back_from_schema_mode_to_json_mode():
    """Many OpenAI-compatible endpoints have JSON mode but not schema
    enforcement. Recording which one we got is what lets profile_gen know it
    must validate and retry."""
    result = await run_probe(FakeProvider(models=["m1"], structured="json_object"), "m1")
    assert result.capabilities.structured_output == "json_object"
    detail = dict((c.id, c.detail) for c in result.checks)["structured"]
    assert "not enforced" in detail


async def test_probe_records_a_model_that_ignores_tools():
    """Answering in prose instead of calling the tool is a failure the vendor's
    docs will still describe as 'supports tool calling'."""
    result = await run_probe(FakeProvider(models=["m1"], tool_calls=False), "m1")
    assert result.ok  # chat still works
    assert result.capabilities.tool_calling is False


async def test_probe_result_is_json_safe_for_the_wire():
    result = await run_probe(FakeProvider(models=["m1"]), "m1")
    json.dumps(result.to_json())  # must not raise
