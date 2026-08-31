"""Generate an agent profile from a short prompt (PROJECT_BRIEF.md §11).

**Validate and retry, always.** Not when the endpoint says it lacks schema
enforcement — always. The probe against DeepSeek confirmed the case this rule
exists for: `structured_output` there is `json_object`, which asks for valid
JSON and enforces nothing about its shape. But even a schema-enforcing endpoint
can return a stray prose wrapper, a markdown fence, or an avatar slot that
exists in the enum and not in our asset folder. Trusting the mode is how M2
would fail in a way that looks like a model problem.

Nothing here saves anything. §11 is explicit that the profile is shown to the
user to edit first, and never written automatically.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from pydantic import ValidationError

from ..providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    LLMProvider,
    Message,
    ProviderError,
    TextChunk,
    Usage,
    was_truncated,
)
from .avatar import AVATAR_SLOTS
from .schemas import GeneratedProfile, json_schema_for_prompt

log = logging.getLogger("agentd.profile_gen")

#: Enough for a profile plus a reasoning model's preamble. The probe learned
#: this the hard way: 128 tokens cut a 29-character JSON reply in half.
MAX_TOKENS = 4096

#: Two retries. Three total attempts is where a model that can do this succeeds
#: and one that cannot stops costing money.
MAX_ATTEMPTS = 3

_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)

SYSTEM_PROMPT = """You design characters for a multi-agent workstation.

Return ONE JSON object and nothing else. No prose, no markdown fence.

The object must have exactly these keys:

  "name":               a short personal name
  "title":              their job title, a few words
  "role":               one line on what they actually do
  "backstory":          two or three sentences
  "personality_traits": an ARRAY of 3 to 5 short strings, e.g. ["methodical", "blunt"]
  "system_prompt":      the instruction this agent will run under, written in
                        the second person and usable exactly as written
  "avatar_config":      an object with the four keys below

The character is a specialist teammate, not a fantasy hero: `title` and `role`
describe real work.

`avatar_config` must pick one value per slot from exactly these options:
{catalogue}
"""


class ProfileGenerationFailed(RuntimeError):
    """Raised when every attempt failed. Carries the trail, because "it did not
    work" is not something the user can act on."""

    def __init__(self, attempts: list[str], usage: Usage) -> None:
        super().__init__(attempts[-1] if attempts else "no attempts were made")
        self.attempts = attempts
        self.usage = usage


@dataclass
class GenerationResult:
    profile: GeneratedProfile
    usage: Usage = field(default_factory=Usage)
    attempts: int = 1
    #: What went wrong on the way, if anything. Surfaced rather than hidden: a
    #: profile that took three tries says something about the model the user
    #: has chosen, and §1 says the UI must not pretend otherwise.
    recovered_from: list[str] = field(default_factory=list)


def _catalogue_text() -> str:
    return "\n".join(
        f"  {slot}: {', '.join(values)}" for slot, values in AVATAR_SLOTS.items()
    )


def extract_json(text: str) -> str:
    """Pull the JSON object out of a reply that may be wrapped.

    Models in JSON mode still occasionally fence their output or add a sentence.
    Stripping that here costs one regex; treating it as a failure costs a retry
    and the user's money.
    """
    fenced = _FENCE.search(text)
    if fenced:
        return fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return text[start : end + 1]
    return text.strip()


def _describe(exc: ValidationError) -> str:
    """A correction the model can act on, not a stack trace."""
    parts = []
    for err in exc.errors():
        where = ".".join(str(p) for p in err["loc"]) or "(root)"
        parts.append(f"{where}: {err['msg']}")
    return "; ".join(parts)


async def generate_profile(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    role: str,
    brief: str = "",
    max_attempts: int = MAX_ATTEMPTS,
) -> GenerationResult:
    """Ask for a profile, validate it, and correct the model until it fits."""
    system = SYSTEM_PROMPT.format(catalogue=_catalogue_text())
    ask = f"Role: {role}"
    if brief.strip():
        ask += f"\nNotes: {brief.strip()}"

    messages = [Message("user", ask)]
    total = Usage()
    failures: list[str] = []

    for attempt in range(1, max_attempts + 1):
        text, usage, stop_reason = await _one_attempt(
            provider, caps, model, system, messages
        )
        total = Usage(
            input_tokens=total.input_tokens + usage.input_tokens,
            output_tokens=total.output_tokens + usage.output_tokens,
            cache_read_tokens=total.cache_read_tokens + usage.cache_read_tokens,
            cache_write_tokens=total.cache_write_tokens + usage.cache_write_tokens,
        )

        if was_truncated(stop_reason):
            # Distinguished from bad JSON on purpose: the model was not wrong,
            # it was cut off, and the correction to send back is different.
            problem = (
                "the reply was cut off at max_tokens before the JSON closed; "
                "answer with a shorter backstory"
            )
        else:
            try:
                payload = json.loads(extract_json(text))
            except json.JSONDecodeError as exc:
                problem = f"the reply was not valid JSON ({exc})"
            else:
                try:
                    profile = GeneratedProfile.model_validate(payload)
                except ValidationError as exc:
                    problem = _describe(exc)
                else:
                    return GenerationResult(
                        profile=profile,
                        usage=total,
                        attempts=attempt,
                        recovered_from=failures,
                    )

        failures.append(problem)
        log.info("profile generation attempt %d failed: %s", attempt, problem)
        if attempt < max_attempts:
            # Feed the model its own output plus the correction. Re-asking from
            # scratch throws away whatever it got right.
            messages = messages + [
                Message("assistant", text[:2000]),
                Message(
                    "user",
                    f"That was rejected: {problem}. "
                    "Return the corrected JSON object only.",
                ),
            ]

    raise ProfileGenerationFailed(failures, total)


async def _one_attempt(
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    system: str,
    messages: list[Message],
) -> tuple[str, Usage, str | None]:
    request = ChatRequest(
        model=model,
        messages=messages,
        system=system,
        max_tokens=MAX_TOKENS,
        response_schema=json_schema_for_prompt(),
    )
    parts: list[str] = []
    usage = Usage()
    stop_reason: str | None = None

    try:
        async for chunk in provider.stream(request, caps):
            if isinstance(chunk, TextChunk):
                parts.append(chunk.text)
            elif isinstance(chunk, DoneChunk):
                usage, stop_reason = chunk.usage, chunk.stop_reason
    except ProviderError:
        # Not retried here: a 401 or an unreachable endpoint will not fix itself
        # on the next attempt, and burning three calls on it wastes the user's
        # money to reach the same answer.
        raise

    return "".join(parts), usage, stop_reason
