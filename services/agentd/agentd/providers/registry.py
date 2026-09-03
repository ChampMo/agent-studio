"""The only place that knows which provider classes exist (PROJECT_BRIEF.md §3.1).

`agents/runtime.py` imports from here and never from a provider module, so
adding a vendor means adding one entry below and touching nothing else. There is
a test that fails if the runtime ever imports a provider directly.
"""

from __future__ import annotations

from typing import Any, Protocol

from ..core import secrets
from ..db.models import ProviderProfile
from .anthropic_provider import AnthropicProvider
from .base import Capabilities, LLMProvider, ProviderError
from .native_search import supports_native_search
from .openai_compatible import OpenAICompatibleProvider


class _Factory(Protocol):
    def __call__(self, *, api_key: str, base_url: str | None) -> LLMProvider: ...


_FACTORIES: dict[str, _Factory] = {
    OpenAICompatibleProvider.kind: OpenAICompatibleProvider,
    AnthropicProvider.kind: AnthropicProvider,
}


def available_kinds() -> list[str]:
    return sorted(_FACTORIES)


def build(kind: str, *, api_key: str, base_url: str | None = None) -> LLMProvider:
    factory = _FACTORIES.get(kind)
    if factory is None:
        raise ProviderError(
            "unknown_provider_kind",
            f"no provider registered for {kind!r}; known: {', '.join(available_kinds())}",
        )
    return factory(api_key=api_key, base_url=base_url)


#: What to send as the key when there is none.
#:
#: A server on this machine — Ollama, LM Studio, llama.cpp — authenticates
#: nothing, and both SDKs refuse to construct without *some* string. This is
#: that string. It is not a credential, it never leaves the process, and it is
#: deliberately readable rather than a plausible-looking token, so anyone who
#: sees it in a request knows immediately that no key was configured.
NO_KEY_NEEDED = "no-key-configured"


def build_from_profile(profile: ProviderProfile) -> LLMProvider:
    """Construct from a stored profile, pulling the key from the keychain.

    The key is read here and handed straight to the SDK. It is never returned,
    logged, or written anywhere else (§9.2).

    **A missing key is not an error here.** It used to be, which meant a local
    server could not be used at all: Ollama and LM Studio want no key, and this
    refused to build a client before either had a chance to say so. Whether a
    key is required is a fact about the endpoint, and the endpoint is the only
    thing that knows it — so the request goes out and a 401 comes back with the
    endpoint's own wording, instead of this app guessing on its behalf (§3.1).
    """
    key = secrets.get_key(profile.id) or NO_KEY_NEEDED
    provider = build(profile.kind, api_key=key, base_url=profile.base_url)
    # Turned on per profile, and only the Anthropic adapter knows what to do
    # with it. Set after construction so the factory signature stays the same
    # for every kind (§16.8).
    if getattr(profile, "native_search", False) and hasattr(provider, "_native_search"):
        provider._native_search = True  # noqa: SLF001 - one flag, one owner
    return provider


def capabilities_for(profile: ProviderProfile) -> Capabilities:
    """Observed capabilities, or conservative defaults until the probe has run.

    Defaults claim nothing: an unprobed endpoint is assumed to do plain chat
    only, so the first run degrades instead of erroring on an unsupported field.
    """
    return Capabilities.from_json(profile.capabilities)


def search_order() -> tuple[Any, ...]:
    """The order search keys are tried in, as ORDER BY terms (§16.5).

    One definition, used by the runner that spends the keys and by the panel
    that lists them. Two `order_by` clauses would be two answers to "which is
    tried first", and the one on screen would be the one that is wrong (§2.1).

    Null sorts last: a chain nobody has reordered still runs oldest-first, which
    is what it did before the column existed.
    """
    return (
        ProviderProfile.sort_order.is_(None),
        ProviderProfile.sort_order,
        ProviderProfile.created_at,
    )


def profile_to_json(profile: ProviderProfile) -> dict[str, Any]:
    """Safe for the wire. Note what is absent: there is no key field to leak."""
    return {
        "id": profile.id,
        "name": profile.name,
        "kind": profile.kind,
        "baseUrl": profile.base_url,
        "model": profile.model,
        "capabilities": profile.capabilities,
        "verifiedAt": profile.verified_at.isoformat() if profile.verified_at else None,
        "hasKey": secrets.has_key(profile.id),
        # Two different facts, and the UI needs both: whether this endpoint
        # *can* search for itself, and whether someone turned it on (§16.8).
        "nativeSearch": bool(getattr(profile, "native_search", False)),
        "nativeSearchAvailable": supports_native_search(profile.base_url),
        # What a search endpoint last said about its own allowance, or null
        # where it says nothing. Null is not zero and the UI must not draw it
        # as one (§1.1); it is measured at `verifiedAt`, not now.
        "quota": getattr(profile, "quota", None),
    }
