"""The shape of a generated agent profile.

This is the contract the model is asked to fill in, and the one the reply is
validated against. It is deliberately *not* the shape of the `agents` row: the
model writes the character, the user chooses the machinery.

Which fields the model does **not** get to decide, and why:

* `provider_id` / `model` — it has no idea which providers this machine has
  configured, so anything it picked would be a guess the user then has to undo.
* `tools` — the registry is empty in M1/M2. A model asked for tools invents
  plausible names, and an agent carrying tools that do not exist is a lie the
  team validator would later have to unpick.
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
    avatar_config: dict[str, str]

    @field_validator("personality_traits")
    @classmethod
    def _trim_traits(cls, traits: list[str]) -> list[str]:
        cleaned = [t.strip() for t in traits if t and t.strip()]
        if not cleaned:
            raise ValueError("personality_traits cannot be empty")
        return cleaned[:MAX_TRAITS]

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
    schema["additionalProperties"] = False
    return schema
