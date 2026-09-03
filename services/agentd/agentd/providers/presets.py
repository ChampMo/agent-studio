"""Starting points for adding a model endpoint (§3.2).

A preset is **a guess at your setup that you confirm by pressing a button**. It
fills in a base URL and says whether a key is usually needed; it asserts nothing,
because the next step asks the endpoint for its model list and that either works
or does not. Every field stays editable — a default port is a default, not a
promise about this machine.

Served from here rather than written into the frontend for the same reason the
search engines are: the backend owns which kinds it can build, and a list in the
UI would drift the first time one is added.

What is deliberately *not* here: model ids. Which models an endpoint serves is
a question with a live answer (`POST /providers/models`), and a shipped list of
names goes stale silently — the mistake `pricing.json` is careful not to make
with rates (§6.2). CLAUDE.md already records two model ids this project was
unsure about; guessing more of them in a dropdown would be worse than the text
field it replaces.
"""

from __future__ import annotations

from typing import Any

#: Ordered: the hosted ones people arrive with first, then the local servers.
PRESETS: tuple[dict[str, Any], ...] = (
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "kind": "openai_compatible",
        "baseUrl": "https://api.deepseek.com/v1",
        "needsKey": True,
        "local": False,
    },
    {
        "id": "anthropic",
        "name": "Anthropic",
        "kind": "anthropic",
        # The SDK carries its own; sending an empty string would overwrite it.
        "baseUrl": None,
        "needsKey": True,
        "local": False,
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "kind": "openai_compatible",
        "baseUrl": "https://api.openai.com/v1",
        "needsKey": True,
        "local": False,
    },
    {
        "id": "ollama",
        "name": "Ollama (on this machine)",
        "kind": "openai_compatible",
        # Ollama's default port. Editable, because a default is not a fact
        # about this machine.
        "baseUrl": "http://localhost:11434/v1",
        "needsKey": False,
        "local": True,
    },
    {
        "id": "lmstudio",
        "name": "LM Studio (on this machine)",
        "kind": "openai_compatible",
        "baseUrl": "http://localhost:1234/v1",
        "needsKey": False,
        "local": True,
    },
    {
        "id": "custom",
        "name": "Something else, OpenAI-compatible",
        "kind": "openai_compatible",
        "baseUrl": "",
        "needsKey": True,
        "local": False,
    },
)


def describe() -> list[dict[str, Any]]:
    return [dict(preset) for preset in PRESETS]
