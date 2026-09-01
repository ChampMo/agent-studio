"""Which endpoints may search for themselves (§16.8).

One list, one function, because the answer has to be the same in three places:
the API that accepts the flag, the UI that offers it, and the adapter that acts
on it. A setting the UI shows and the backend ignores is worse than no setting.

The entry here was established the way §3.1 asks: the documentation was read —
`https://api.deepseek.com/anthropic` is the Anthropic-compatible base URL, and
`web_search_tool_result` appears in its compatibility table — and then the
request was actually sent. The endpoint answered with `server_tool_use` and
`web_search_tool_result` blocks, having done the searching itself, with results
carrying `encrypted_content`.

What the documentation does *not* say is how to enable it. That was found by
sending Anthropic's own server-tool spec and reading the reply, which is why
this list is short: it holds endpoints someone has actually tried.
"""

from __future__ import annotations

from urllib.parse import urlparse

#: (host, path prefix) pairs that answer to a server-side web search.
#:
#: The path matters as much as the host: the same host serves an
#: OpenAI-compatible API at `/v1` that does not do this, and pointing an
#: Anthropic adapter at that one fails in a way that looks like a key problem.
KNOWN: tuple[tuple[str, str], ...] = (("api.deepseek.com", "/anthropic"),)


def supports_native_search(base_url: str | None) -> bool:
    """Whether this endpoint is one that runs the search itself."""
    if not base_url:
        return False
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/") or "/"
    return any(
        host == known_host and path.startswith(known_path)
        for known_host, known_path in KNOWN
    )


def describe() -> list[dict[str, str]]:
    """For the UI: which base URLs this build can offer the flag on."""
    return [
        {"host": host, "path": path, "baseUrl": f"https://{host}{path}"}
        for host, path in KNOWN
    ]
