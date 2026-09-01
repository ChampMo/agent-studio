"""web_search, over a search endpoint the user configured (§16.5).

Tavily first, because it returns extracted content rather than a page of links:
an agent that gets ten URLs has to fetch ten pages to learn anything, and each
fetch is another chance to read something written to be read by an agent.

The key lives in the keychain beside the model keys and is read the same way
(§9.2). With no key the tool is not offered at all — `GET /tools` leaves it out
and the runner never puts it in a toolbox — rather than being offered and
failing on every call (§15 row 32).

Results are wrapped exactly like a fetched page: they are text somebody else
wrote, and the fact that a search engine handed it over does not make it an
instruction (§16.6).
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from .base import ToolContext, ToolFailed, ToolResult
from .web import as_untrusted

DEFAULT_ENDPOINT = "https://api.tavily.com"
TIMEOUT_SEC = 25.0
MAX_RESULTS = 5
#: Characters of extracted content kept per result.
MAX_RESULT_CHARS = 2000


@dataclass(frozen=True)
class SearchEndpoint:
    """Where to search and what to authenticate with.

    Built by the runner from the stored profile plus the keychain, and handed to
    the tool in its context. The tool never reads either itself — the same rule
    as the workspace (§16.2).
    """

    api_key: str
    base_url: str = DEFAULT_ENDPOINT


async def web_search(ctx: ToolContext, *, query: str) -> ToolResult:
    """Search the web and return extracted content, marked as untrusted."""
    endpoint = ctx.extras.get("search")
    if not isinstance(endpoint, SearchEndpoint):
        # Unreachable when the registry filtering is working: this tool is only
        # in a toolbox when a key exists.
        raise ToolFailed(
            "no_search_provider",
            "no search endpoint is configured, so the web cannot be searched",
        )
    if not query or not query.strip():
        raise ToolFailed("empty_query", "a search query is required")

    payload = {
        "api_key": endpoint.api_key,
        "query": query,
        "max_results": MAX_RESULTS,
        # The point of choosing this endpoint: text, not just links.
        "include_answer": False,
        "include_raw_content": False,
        "search_depth": "basic",
    }

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
            response = await client.post(f"{endpoint.base_url}/search", json=payload)
    except httpx.HTTPError as exc:
        raise ToolFailed("search_failed", f"the search endpoint could not be reached: {exc}") from exc

    if response.status_code == 401:
        raise ToolFailed("bad_key", "the search endpoint rejected the API key")
    if response.status_code >= 400:
        raise ToolFailed(
            "search_failed", f"the search endpoint answered {response.status_code}"
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise ToolFailed("search_failed", "the search endpoint did not return JSON") from exc

    results = data.get("results") or []
    if not results:
        return ToolResult(
            content=f"No results for {query!r}.",
            summary=f"searched for {query!r}: nothing found",
            details={"results": 0},
        )

    blocks: list[str] = []
    for item in results[:MAX_RESULTS]:
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or "").strip()
        content = str(item.get("content") or "").strip()[:MAX_RESULT_CHARS]
        blocks.append(f"## {title}\n{url}\n\n{content}")

    body = "\n\n---\n\n".join(blocks)
    return ToolResult(
        content=as_untrusted(f"a web search for {query!r}", body),
        summary=f"searched for {query!r}: {len(blocks)} result(s)",
        details={"results": len(blocks)},
    )
