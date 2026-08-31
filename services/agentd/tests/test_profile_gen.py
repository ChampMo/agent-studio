"""M2 proof: a profile is validated and corrected, never trusted (§3.1, §11).

The probe established the fact this file defends against: DeepSeek's structured
output is `json_object`, which guarantees valid JSON and nothing about its
shape. So the schema is a hint to the model and `GeneratedProfile` is the
enforcement — and the retry is what turns a near-miss into a usable profile
instead of an error the user has to interpret.
"""

from __future__ import annotations

import json

import pytest

from agentd.agents.avatar import AVATAR_SLOTS, InvalidAvatar, validate_avatar
from agentd.agents.profile_gen import (
    ProfileGenerationFailed,
    extract_json,
    generate_profile,
)
from agentd.agents.schemas import GeneratedProfile, json_schema_for_prompt
from agentd.providers.base import (
    Capabilities,
    DoneChunk,
    ProviderError,
    TextChunk,
    Usage,
)

GOOD = {
    "name": "Mira Vale",
    "title": "Research Analyst",
    "role": "Finds and summarises source material",
    "backstory": "Ten years in an archive taught her to distrust a single source.",
    "personality_traits": ["methodical", "sceptical", "concise"],
    "system_prompt": "You are Mira Vale. Verify before you assert.",
    "avatar_config": {
        "body": "slim",
        "hair": "bun",
        "outfit": "blazer",
        "palette": "teal",
    },
}


class ScriptedModel:
    """Returns a canned reply per attempt, and records what it was asked.

    A reply is either text (finished normally) or a `(text, stop_reason)` pair,
    so a test can truncate a specific attempt rather than all of them.
    """

    kind = "fake"

    def __init__(self, replies, *, raises=None):
        self._replies = [r if isinstance(r, tuple) else (r, "stop") for r in replies]
        self._raises = raises
        self.requests = []

    async def list_models(self):
        return ["m1"]

    async def stream(self, req, caps):
        self.requests.append(req)
        if self._raises:
            raise self._raises
        reply, stop = self._replies.pop(0) if self._replies else ("{}", "stop")
        yield TextChunk(reply)
        yield DoneChunk(stop, Usage(50, 120))

    async def aclose(self):
        return None


async def run(model, **kw):
    return await generate_profile(
        provider=model,
        caps=Capabilities(structured_output="json_object"),
        model="m1",
        role="research analyst",
        **kw,
    )


# ---- the happy path -----------------------------------------------------


async def test_a_valid_reply_is_accepted_first_time():
    result = await run(ScriptedModel([json.dumps(GOOD)]))
    assert result.attempts == 1
    assert result.recovered_from == []
    assert result.profile.name == "Mira Vale"
    assert result.usage.output_tokens == 120


async def test_the_prompt_shows_the_model_the_asset_catalogue():
    """The model cannot choose from a list it was never given (§11)."""
    model = ScriptedModel([json.dumps(GOOD)])
    await run(model)
    system = model.requests[0].system
    for slot, values in AVATAR_SLOTS.items():
        assert slot in system
        assert values[0] in system


# ---- validate and retry -------------------------------------------------


async def test_a_reply_that_is_not_json_is_corrected():
    model = ScriptedModel(["Certainly! Here is your character.", json.dumps(GOOD)])
    result = await run(model)
    assert result.attempts == 2
    assert "not valid JSON" in result.recovered_from[0]


async def test_an_invented_avatar_asset_is_rejected_and_corrected():
    """The case the closed catalogue exists for: without this the scene loads a
    sprite that does not exist, three milestones from now."""
    invented = {**GOOD, "avatar_config": {**GOOD["avatar_config"], "hair": "silver_mane"}}
    model = ScriptedModel([json.dumps(invented), json.dumps(GOOD)])
    result = await run(model)

    assert result.attempts == 2
    assert "silver_mane" in result.recovered_from[0]
    # The correction names the legal values, so the retry has what it needs.
    correction = model.requests[1].messages[-1].content
    assert "bun" in correction or "silver_mane" in correction


async def test_a_missing_field_is_reported_by_name():
    incomplete = {k: v for k, v in GOOD.items() if k != "system_prompt"}
    model = ScriptedModel([json.dumps(incomplete), json.dumps(GOOD)])
    result = await run(model)
    assert "system_prompt" in result.recovered_from[0]


async def test_the_retry_carries_the_previous_answer_forward():
    """Re-asking from scratch throws away whatever the model got right."""
    model = ScriptedModel(["not json", json.dumps(GOOD)])
    await run(model)

    second = model.requests[1].messages
    roles = [m.role for m in second]
    assert roles == ["user", "assistant", "user"]
    assert second[1].content.startswith("not json")


async def test_truncation_is_corrected_differently_from_bad_json():
    """A cut-off reply is not a wrong reply, and the useful correction differs:
    shorten the answer, rather than fix the shape."""
    model = ScriptedModel([('{"name": "Mi', "length"), json.dumps(GOOD)])
    result = await run(model)
    assert "cut off" in result.recovered_from[0]
    assert "shorter" in model.requests[1].messages[-1].content


async def test_giving_up_reports_every_attempt():
    model = ScriptedModel(["nope", "still nope", "nope again"])
    with pytest.raises(ProfileGenerationFailed) as exc:
        await run(model)
    assert len(exc.value.attempts) == 3
    # Usage across all three is preserved: the user paid for them.
    assert exc.value.usage.output_tokens == 360


async def test_a_provider_error_is_not_retried():
    """A 401 will not fix itself on attempt two, and three calls to reach the
    same answer is the user's money."""
    model = ScriptedModel([], raises=ProviderError("provider_auth", "key rejected"))
    with pytest.raises(ProviderError):
        await run(model)
    assert len(model.requests) == 1


# ---- shapes and helpers -------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected_name"),
    [
        ('{"name": "A"}', "A"),
        ('```json\n{"name": "A"}\n```', "A"),
        ('```\n{"name": "A"}\n```', "A"),
        ('Here you go:\n{"name": "A"}\nHope that helps!', "A"),
    ],
)
def test_json_is_recovered_from_a_wrapped_reply(raw, expected_name):
    """Stripping a fence costs one regex; treating it as a failure costs a
    retry and the user's money."""
    assert json.loads(extract_json(raw))["name"] == expected_name


def test_the_schema_sent_to_the_provider_enumerates_the_avatar_slots():
    """So an endpoint that does enforce schemas rejects an invented asset before
    it ever reaches us."""
    schema = json_schema_for_prompt()
    avatar = schema["properties"]["avatar_config"]
    assert avatar["additionalProperties"] is False
    for slot, values in AVATAR_SLOTS.items():
        assert avatar["properties"][slot]["enum"] == list(values)


def test_the_generated_shape_excludes_what_the_model_must_not_choose():
    """provider/model would be guesses about this machine; tools would be names
    of things that do not exist; exp is earned."""
    fields = set(GeneratedProfile.model_fields)
    assert not fields & {"provider_id", "model", "tools", "exp", "total_missions"}


def test_avatar_validation_reports_every_problem_at_once():
    """One problem per round trip would cost four calls to fix one avatar."""
    with pytest.raises(InvalidAvatar) as exc:
        validate_avatar({"body": "gigantic", "hair": "silver_mane"})
    joined = " ".join(exc.value.problems)
    assert "gigantic" in joined
    assert "silver_mane" in joined
    assert "outfit" in joined  # missing slots are reported too
    assert "palette" in joined
