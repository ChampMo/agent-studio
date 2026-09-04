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

from ..core.jsonish import extract_json
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

SYSTEM_PROMPT = """You design characters for a multi-agent workstation.

Every character in this app is drawn as a **cat** at a desk in a shared office.
That is not a theme to write about — it is what the picture beside the name
will be — so the name has to sit on a cat without explanation, while the title
and role stay entirely serious.

Return ONE JSON object and nothing else. No prose, no markdown fence.

The object must have exactly these keys:

  "name":               a short single-word name that suits a cat and a
                        colleague equally: Pepper, Juniper, Wren, Moss, Otto,
                        Clove. No surname, no honorific, no species word — do
                        not call anyone Whiskers, Cat, Kitty or Miss Paws, and
                        do not use any name listed as taken below.
  "title":              their job title, a few words
  "role":               one line on what they actually do
  "backstory":          two or three sentences
  "personality_traits": an ARRAY of 3 to 5 short strings, e.g. ["methodical", "blunt"]
  "system_prompt":      the instruction this agent will run under, written in
                        the second person and usable exactly as written
  "tools":              an ARRAY of tool ids this agent should carry, chosen
                        from the list below. Pick only what the role actually
                        needs; an empty array is a real answer.
  "avatar_config":      an object with the four keys below

The character is a specialist teammate, not a fantasy hero: `title` and `role`
describe real work.

`tools` must use ids from exactly this list, and nothing else:
{tools}

`avatar_config` must pick one value per slot from exactly these options:
{catalogue}
{taken}"""

#: Appended only when there is something in it. An empty "already taken:"
#: heading is a line of prompt spent saying nothing, and it is re-sent on every
#: correction round.
TAKEN_PROMPT = """
These names are already in use by other agents on this machine. Pick a
different one — teammates are addressed by name, so two agents with the same
name cannot both be reached:
{names}
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


def _norm(name: str) -> str:
    """One answer to "are these the same name".

    The same normalisation `validator.py` uses for `duplicate_name`, and
    deliberately the same function's worth of it: if the generator considered
    "Wren" and "wren " different while the run gate considered them the same,
    the generator would happily produce a team the launcher then refuses (§2.1).
    """
    return name.strip().casefold()


def _taken_text(taken: list[str]) -> str:
    """The names to avoid, or nothing at all.

    Sorted so two runs with the same roster send byte-identical prompts and the
    provider's prompt cache still hits — the same reason `system_addendum`
    composes its rules in a fixed order.
    """
    if not taken:
        return ""
    return TAKEN_PROMPT.format(names="\n".join(f"  {name}" for name in sorted(taken)))


def _catalogue_text() -> str:
    return "\n".join(
        f"  {slot}: {', '.join(values)}" for slot, values in AVATAR_SLOTS.items()
    )


def _describe(exc: ValidationError) -> str:
    """A correction the model can act on, not a stack trace."""
    parts = []
    for err in exc.errors():
        where = ".".join(str(p) for p in err["loc"]) or "(root)"
        parts.append(f"{where}: {err['msg']}")
    return "; ".join(parts)


def _tools_text(tool_ids: list[str] | None) -> str:
    """The tools this machine can actually run, with what each is for.

    Passed in rather than read here, for the same reason the workspace is: what
    exists depends on keys and on the machine, and the caller is what knows
    (§16.5). Without descriptions a model picks by the sound of the name.
    """
    from ..tools import registry as tool_registry

    specs = [
        spec
        for spec in tool_registry.all_specs()
        if tool_ids is None or spec.id in tool_ids
    ]
    return "\n".join(
        f"  {spec.id:<14}{spec.risk:<10}{spec.description.splitlines()[0]}"
        for spec in specs
    )


async def generate_profile(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    role: str,
    brief: str = "",
    max_attempts: int = MAX_ATTEMPTS,
    available_tools: list[str] | None = None,
    taken: list[str] | None = None,
) -> GenerationResult:
    """Ask for a profile, validate it, and correct the model until it fits.

    `taken` is the names that already exist. It is both told to the model and
    **checked afterwards**, which is the rule every other closed set here
    follows: the avatar catalogue is in the prompt and enforced by
    `GeneratedProfile`, the tool ids are in the prompt and enforced on the way
    back. A prompt is a request, and this project has already paid for treating
    one as a guarantee — the generator named two different agents "Mara"
    because nothing checked, and `send_message` then delivered one of them the
    other's mail.
    """
    taken = taken or []
    system = SYSTEM_PROMPT.format(
        catalogue=_catalogue_text(),
        tools=_tools_text(available_tools),
        taken=_taken_text(taken),
    )
    # Checked against the normalised form, so the comparison does not depend on
    # how the caller happened to spell what it passed in.
    unavailable = {_norm(n) for n in taken}
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
                    if _norm(profile.name) in unavailable:
                        # Falls into the same correction path as a bad avatar
                        # slot rather than raising: the model got everything
                        # else right and has one field to move. Naming the
                        # clash is what makes the next attempt cheap.
                        problem = (
                            f"the name {profile.name!r} already belongs to "
                            "another agent on this machine; keep the rest of "
                            "the profile and choose a different name"
                        )
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
