"""What a reply this build could not parse is allowed to prove (§3.1).

`deepseek-v4-pro` was reported "3 of 4 passed · 1 failed — reply was not usable
JSON", and `structured: none` was written onto its profile. Asked the same
question again it answered `{"ok": false, "note": "No task was provided."}`,
which parses. The endpoint had never refused JSON mode; one reply had simply not
come back clean, and our reading of it became a recorded fact about the model.

The distinction these tests hold:

* **refused** — the endpoint returned an error for the mode. That is the
  endpoint's own answer, it is conclusive, and `none` is the honest record.
* **accepted, unparseable** — nothing was learned. Inconclusive, and nothing is
  written, so a previous reading is not overwritten by a bad sample.
* **wrapped in a fence** — that is JSON. The same lenient extraction
  `profile_gen` has used since M2.
"""

from __future__ import annotations

import pytest

from agentd.providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    ProviderError,
    TextChunk,
    Usage,
)
from agentd.providers.probe import run_probe

pytestmark = pytest.mark.anyio


class FakeProvider:
    """Answers every probe step, with the structured reply under test."""

    kind = "openai_compatible"

    def __init__(self, *, structured_reply=None, structured_error=None):
        self._structured_reply = structured_reply
        self._structured_error = structured_error

    async def list_models(self):
        return ["m1"]

    async def stream(self, req: ChatRequest, caps: Capabilities):
        if req.response_schema is not None:
            # Like DeepSeek: schema mode is refused outright, JSON mode works.
            # The probe tries the strongest first, so this is the path a real
            # endpoint of this shape takes.
            if caps.structured_output == "schema":
                raise ProviderError("bad_request", "This response_format type is unavailable now")
            if self._structured_error is not None:
                raise self._structured_error
            yield TextChunk(self._structured_reply or "")
        elif req.tools:
            # Tool calling is not what these tests are about; it may fail.
            yield TextChunk("no tool for me")
        else:
            yield TextChunk("ready")
        yield DoneChunk(stop_reason="stop", usage=Usage(input_tokens=1, output_tokens=1))

    async def aclose(self):
        return None


def structured(result):
    return next(c for c in result.checks if c.id == "structured")


async def test_a_clean_reply_records_json_mode():
    result = await run_probe(FakeProvider(structured_reply='{"ok": true, "note": "hi"}'), "m1")
    assert structured(result).status == "pass"
    assert result.capabilities.structured_output == "json_object"
    assert "structured_output" in result.conclusive


async def test_a_fenced_reply_is_still_json():
    # Stripping the fence costs one regex. Calling it a failure costs the user
    # a capability they actually have.
    result = await run_probe(
        FakeProvider(structured_reply='```json\n{"ok": true, "note": "hi"}\n```'),
        "m1",
    )
    assert structured(result).status == "pass"
    assert result.capabilities.structured_output == "json_object"


async def test_a_reply_with_a_preamble_is_still_json():
    result = await run_probe(
        FakeProvider(structured_reply='Sure! {"ok": true, "note": "hi"} — hope that helps'),
        "m1",
    )
    assert structured(result).status == "pass"


async def test_an_unparseable_reply_from_an_endpoint_that_accepted_the_mode():
    """The bug. Nothing was learned, so nothing is recorded."""
    result = await run_probe(FakeProvider(structured_reply="I would rather not"), "m1")
    check = structured(result)
    assert check.status == "inconclusive"
    # Not written: an endpoint that took the parameter without complaint has not
    # told us it has no JSON mode.
    assert "structured_output" not in result.conclusive
    assert "accepted" in check.detail
    assert "nothing was recorded" in check.detail


async def test_a_refused_mode_is_a_real_answer_and_is_recorded():
    # Here the endpoint itself said no. That is conclusive, and `none` is true.
    result = await run_probe(
        FakeProvider(structured_error=ProviderError("bad_request", "unsupported")),
        "m1",
    )
    check = structured(result)
    assert check.status == "fail"
    assert result.capabilities.structured_output == "none"
    assert "structured_output" in result.conclusive
