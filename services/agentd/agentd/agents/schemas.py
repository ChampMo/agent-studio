"""The shape of a generated agent profile.

This is the contract the model is asked to fill in, and the one the reply is
validated against. It is deliberately *not* the shape of the `agents` row: the
model writes the character, the user chooses the machinery.

Which fields the model does **not** get to decide, and why:

* `provider_id` / `model` — it has no idea which providers this machine has
  configured, so anything it picked would be a guess the user then has to undo.
* ~~`tools`~~ — this was excluded because the registry was empty until M8: a
  model asked for tools invented plausible names, and an agent carrying tools
  that do not exist is a lie the validator would later have to unpick. That
  reason expired when the tools became real, so the model may now choose them
  — from the list it is shown, checked against the registry on the way back,
  exactly as the avatar catalogue works (§11, §16.1). An invented tool is
  still refused; it is just no longer the only possible outcome.
* `total_missions` — recorded from missions that actually finished, never
  claimed (§5).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

from .avatar import AVATAR_SLOTS, InvalidAvatar, validate_avatar

MAX_TRAITS = 6


class GeneratedProfile(BaseModel):
    """What `profile_gen` asks the model for, and validates on the way back."""

    name: str = Field(min_length=1, max_length=60)
    title: str = Field(min_length=1, max_length=80, description="Short role epithet.")
    role: str = Field(min_length=1, max_length=120)
    backstory: str = Field(min_length=1, max_length=2000)
    personality_traits: list[str] = Field(min_length=1, max_length=MAX_TRAITS)
    system_prompt: str = Field(min_length=1, max_length=4000)
    #: Tool ids from the registry. Empty is a real answer: a summariser that
    #: only reads what teammates send it needs none.
    tools: list[str] = Field(default_factory=list)
    avatar_config: dict[str, str]

    @field_validator("personality_traits")
    @classmethod
    def _trim_traits(cls, traits: list[str]) -> list[str]:
        cleaned = [t.strip() for t in traits if t and t.strip()]
        if not cleaned:
            raise ValueError("personality_traits cannot be empty")
        return cleaned[:MAX_TRAITS]

    @field_validator("tools")
    @classmethod
    def _known_tools_only(cls, tools: list[str]) -> list[str]:
        # The same rule as the avatar catalogue: chosen from what exists, never
        # invented. A model that names `search_web` gets a correction listing
        # the real ids rather than an agent that fails at launch (§16.1).
        from ..tools import registry as tool_registry

        unknown = [t for t in tools if t not in tool_registry.BY_ID]
        if unknown:
            raise ValueError(
                f"unknown tools: {', '.join(unknown)}. "
                f"Choose from: {', '.join(sorted(tool_registry.BY_ID))}"
            )
        # Order is not meaningful and duplicates say nothing.
        return sorted(dict.fromkeys(tools))

    @field_validator("avatar_config")
    @classmethod
    def _known_assets_only(cls, config: dict[str, str]) -> dict[str, str]:
        # §11: chosen from what exists, never invented. Raised as a plain
        # ValueError so pydantic reports it alongside any other field problem —
        # the retry then gets one message describing everything to fix.
        try:
            return validate_avatar(config)
        except InvalidAvatar as exc:
            raise ValueError("; ".join(exc.problems)) from exc


def json_schema_for_prompt() -> dict[str, Any]:
    """The schema handed to the provider for structured output.

    Enumerating the avatar slots inline is what lets an endpoint with real
    schema enforcement reject an invented asset before it ever reaches us. On an
    endpoint with JSON mode only, the same enumeration still steers the model —
    and `GeneratedProfile` catches what slips through either way (§3.1).
    """
    schema = GeneratedProfile.model_json_schema()
    schema["properties"]["avatar_config"] = {
        "type": "object",
        "properties": {
            slot: {"type": "string", "enum": list(values)}
            for slot, values in AVATAR_SLOTS.items()
        },
        "required": list(AVATAR_SLOTS),
        "additionalProperties": False,
    }
    # Enumerated for the same reason as the avatar slots: an endpoint with real
    # schema enforcement then refuses an invented tool before it reaches us.
    from ..tools import registry as tool_registry

    schema["properties"]["tools"] = {
        "type": "array",
        "items": {"type": "string", "enum": sorted(tool_registry.BY_ID)},
    }
    schema["additionalProperties"] = False
    return schema
