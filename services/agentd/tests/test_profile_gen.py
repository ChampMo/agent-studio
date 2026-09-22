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
from pydantic import ValidationError

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
        "breed": "marmalade",
        "size": "normal",
        "headwear": "bow_red",
        "glasses": "teal",
        "collar": "none",
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
    invented = {**GOOD, "avatar_config": {**GOOD["avatar_config"], "breed": "silver_mane"}}
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


def _valid_avatar() -> dict[str, str]:
    """One legal value per slot, whatever the catalogue happens to hold."""
    return {slot: values[0] for slot, values in AVATAR_SLOTS.items()}


def test_the_schema_sent_to_the_provider_enumerates_the_avatar_slots():
    """So an endpoint that does enforce schemas rejects an invented asset before
    it ever reaches us."""
    schema = json_schema_for_prompt()
    avatar = schema["properties"]["avatar_config"]
    assert avatar["additionalProperties"] is False
    for slot, values in AVATAR_SLOTS.items():
        assert avatar["properties"][slot]["enum"] == list(values)


def test_the_generated_shape_excludes_what_the_model_must_not_choose():
    """provider/model would be guesses about which endpoints this machine has,
    and total_missions is recorded from what actually happened rather than
    claimed."""
    fields = set(GeneratedProfile.model_fields)
    assert not fields & {"provider_id", "model", "total_missions"}


def test_the_model_may_now_choose_tools_because_they_exist():
    """`tools` was excluded while the registry was empty: anything named would
    have been fiction. That reason ended at M8, so the rule became the same one
    the avatar catalogue has always had — choose from what exists."""
    assert "tools" in GeneratedProfile.model_fields

    chosen = GeneratedProfile(
        name="Mira",
        title="Analyst",
        role="checks sources",
        backstory="b",
        personality_traits=["careful"],
        system_prompt="You check sources.",
        tools=["web_search", "read_file", "read_file"],
        avatar_config=_valid_avatar(),
    )
    # Deduplicated and ordered: neither order nor repetition means anything.
    assert chosen.tools == ["read_file", "web_search"]


def test_an_invented_tool_is_refused_with_the_real_names():
    """A correction that lists the ids costs one round trip. "Invalid tool"
    costs as many as the model has guesses."""
    with pytest.raises(ValidationError) as caught:
        GeneratedProfile(
            name="Mira",
            title="Analyst",
            role="r",
            backstory="b",
            personality_traits=["careful"],
            system_prompt="s",
            tools=["search_the_web"],
            avatar_config=_valid_avatar(),
        )
    message = str(caught.value)
    assert "search_the_web" in message
    assert "web_search" in message


def test_carrying_no_tools_is_a_real_answer():
    # A summariser that only reads what teammates send it needs none, and
    # forcing one would be the schema inventing a requirement.
    profile = GeneratedProfile(
        name="Mira",
        title="Summariser",
        role="r",
        backstory="b",
        personality_traits=["brief"],
        system_prompt="s",
        avatar_config=_valid_avatar(),
    )
    assert profile.tools == []


def test_the_schema_sent_to_the_provider_enumerates_the_tools():
    from agentd.tools import registry as tool_registry

    tools = json_schema_for_prompt()["properties"]["tools"]
    assert tools["items"]["enum"] == sorted(tool_registry.BY_ID)


def test_avatar_validation_reports_every_problem_at_once():
    """One problem per round trip would cost four calls to fix one avatar."""
    with pytest.raises(InvalidAvatar) as exc:
        validate_avatar({"size": "gigantic", "breed": "silver_mane"})
    joined = " ".join(exc.value.problems)
    assert "gigantic" in joined
    assert "silver_mane" in joined
    # Missing slots are reported in the same reply, so a model told only about
    # the bad values does not spend a second attempt discovering the gaps.
    assert "headwear is missing" in joined
    assert "glasses is missing" in joined
    assert "collar is missing" in joined


def test_the_human_catalogue_is_refused_rather_than_guessed_at():
    """An avatar written before the office had cats.

    Every part is reported: none of the four human slots exists any more —
    `outfit` and `palette` went with the cat catalogue — and the slots that
    replaced them are missing. Nothing is quietly mapped here:
    `validate` is the door into the table and has to refuse what it cannot
    check. `migrate_avatar` is the one place that translates, and it runs once,
    in a migration, over rows nobody is editing.
    """
    with pytest.raises(InvalidAvatar) as exc:
        validate_avatar({"body": "slim", "hair": "bun", "outfit": "blazer", "palette": "teal"})
    joined = " ".join(exc.value.problems)
    assert "'body' is not an avatar slot" in joined
    assert "'hair' is not an avatar slot" in joined
    assert "'outfit' is not an avatar slot" in joined
    assert "'palette' is not an avatar slot" in joined
    assert "breed is missing" in joined
    assert "size is missing" in joined
    assert "collar is missing" in joined


def test_the_migration_keeps_agents_that_were_created_as_people():
    """One-to-one, so two agents that looked different still do (§5.1)."""
    from agentd.agents.avatar import migrate_avatar

    a = migrate_avatar({"body": "slim", "hair": "bun", "outfit": "blazer", "palette": "teal"})
    b = migrate_avatar({"body": "sturdy", "hair": "buzz", "outfit": "armor", "palette": "ink"})
    assert a != b
    # And what comes out is something the validator will now accept.
    assert validate_avatar(a) == a
    assert validate_avatar(b) == b


def test_every_old_pattern_still_lands_on_a_real_cat():
    """The one-to-one promise, and where it stopped being keepable.

    Migration 0019 wrote the rule down: a mapping must never collapse two
    looks onto one cat, because the person who chose them has no way to tell
    why their agents started matching. It held for three catalogues, because a
    cat was a tint over a shared sprite and a tenth value cost nothing.

    Four cats were then drawn by hand, and nine breeds do not fit into four
    drawings. So the promise is broken deliberately, and what is left to
    assert is the weaker thing that is still true: every historical value
    lands on a cat that exists, chosen by what the animal looks like, and none
    of them falls through to the default by accident. A test asserting the old
    rule would have to be deleted; this one keeps watching the part of it that
    survived.
    """
    from agentd.agents.avatar import migrate_avatar

    coats = (
        "tabby", "tuxedo", "calico", "point",
        "spotted", "shaggy", "sleek", "patched",
    )
    landed = {c: migrate_avatar({"coat": c})["breed"] for c in coats}
    assert set(landed.values()) <= set(AVATAR_SLOTS["breed"])
    # Every one of the four drawn cats is reachable, so the fold spreads the
    # old values out rather than piling them onto the default.
    assert set(landed.values()) == set(AVATAR_SLOTS["breed"])


def test_the_four_drawn_cats_keep_their_own_names():
    """The part of one-to-one that is still whole.

    The four names were already in the previous catalogue for exactly these
    looks, so an agent that was any of them is untouched — which is why the
    mapping chose those four names rather than inventing new ones.
    """
    from agentd.agents.avatar import migrate_avatar

    for name in AVATAR_SLOTS["breed"]:
        assert migrate_avatar({"breed": name})["breed"] == name


def test_the_accessory_slot_splits_only_where_something_was_drawn():
    """`prop` became `headwear` and `glasses`, and most of it became nothing.

    The old slot was held open for art, and four of its values — a scarf,
    headphones, a bandana, an eyepatch — were never drawn. Those land on
    nothing rather than on a hat nobody chose (§5.1). The two that *were*
    drawn keep their meaning, and each lands in the slot for the place it is
    worn: glasses on the eyes, a cap on the head.

    The distinctness this replaces (`test_every_old_outfit_lands_on_its_own_prop`)
    cannot survive here and says so: eight outfits mapped to eight props while
    every prop was a name with no picture, and there are only three real
    destinations now.
    """
    from agentd.agents.avatar import migrate_avatar

    assert migrate_avatar({"prop": "glasses"})["glasses"] == "brown"
    assert migrate_avatar({"prop": "glasses"})["headwear"] == "none"
    assert migrate_avatar({"prop": "cap"})["headwear"] == "cap_brown"
    assert migrate_avatar({"prop": "cap"})["glasses"] == "none"
    # The one guess, kept because it is still a bow and it keeps those agents
    # distinct from the undressed default.
    assert migrate_avatar({"prop": "bow_tie"})["headwear"] == "bow_red"

    for never_drawn in ("scarf", "headphones", "bandana", "eyepatch", "none"):
        landed = migrate_avatar({"prop": never_drawn})
        assert landed["headwear"] == "none"
        assert landed["glasses"] == "none"


def test_an_outfit_still_reaches_the_slot_that_replaced_its_prop():
    """Two catalogues deep: `outfit` was renamed `prop`, and `prop` then split.

    A machine that never ran the intervening builds holds the oldest word, so
    the chain has to carry it all the way — a lab coat is a prop called
    `glasses`, which is now the `glasses` slot.
    """
    from agentd.agents.avatar import migrate_avatar

    assert migrate_avatar({"outfit": "lab_coat"})["glasses"] == "brown"
    assert migrate_avatar({"outfit": "hoodie"})["headwear"] == "cap_brown"


def test_the_one_slot_build_kept_every_cat_its_own_face():
    """A catalogue that existed for one build, and reached a database.

    `cat` was `breed` under another name and the values never changed, so this
    is an identity. Without it every agent on a machine that ran that build
    would come back as the default cat — nine agents wearing one face.
    """
    from agentd.agents.avatar import migrate_avatar

    names = AVATAR_SLOTS["breed"]
    assert {migrate_avatar({"cat": n})["breed"] for n in names} == set(names)


def test_an_avatar_from_before_collars_gets_no_collar():
    """The slot is new, so nobody who predates it chose anything.

    `none` is the value that means exactly that, and it is first in the tuple
    so that is what a missing slot fills in with. A real collar here would put
    a decision in the record that was never made (§5.1) — and the rest of the
    avatar is untouched, which is what keeps two agents that already looked
    different looking different.
    """
    from agentd.agents.avatar import migrate_avatar

    was = {"breed": "bombay", "size": "fat"}
    assert migrate_avatar(was) == {
        **was,
        "headwear": "none",
        "glasses": "none",
        "collar": "none",
    }


def test_the_palette_is_dropped_rather_than_forced_into_a_slot():
    """The one lossy step, and it is deliberate.

    A breed carries its own colouring, so there is nowhere for a separately
    chosen palette to go. Two cats that differed only by palette do end up
    alike — which is the cost that was accepted, and is why `coat` had to stay
    one-to-one to carry the distinctness on its own.
    """
    from agentd.agents.avatar import migrate_avatar

    ginger = migrate_avatar({"coat": "tabby", "palette": "ginger"})
    ink = migrate_avatar({"coat": "tabby", "palette": "ink"})
    assert ginger == ink
    assert "palette" not in ginger


def test_a_migrated_avatar_is_one_the_validator_accepts():
    """The migration writes straight into the column the validator guards, so
    anything it produces has to pass on the way back out."""
    from agentd.agents.avatar import migrate_avatar

    for config in (
        {"coat": "point", "outfit": "vest", "build": "lanky", "palette": "smoke"},
        {"body": "sturdy", "hair": "curly", "outfit": "robe", "palette": "moss"},
        {"nonsense": "entirely"},
        None,
        "not even a dict",
    ):
        out = migrate_avatar(config)
        assert validate_avatar(out) == out
