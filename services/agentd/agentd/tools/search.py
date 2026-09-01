"""web_search, over a search endpoint the user configured (§16.5).

Two endpoints are supported, and which one is in use is decided by the profile's
base URL rather than by a setting that could disagree with it:

* **Tavily** returns extracted page content, so an agent learns something from
  the result itself instead of having to fetch five pages.
* **Brave** returns a title, a URL and a short description per result. Cheaper,
  with a free monthly allowance, which makes it the one to develop against.

The difference is real and is not smoothed over: a Brave result says it is a
summary, so the agent knows to `web_fetch` a page when it needs the text rather
than answering from a snippet as though it had read the page.

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
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx

from .base import ToolContext, ToolFailed, ToolResult
from .web import as_untrusted

TAVILY_ENDPOINT = "https://api.tavily.com"
BRAVE_ENDPOINT = "https://api.search.brave.com"

#: What a profile with no base URL means. Tavily, because it was first and
#: changing it would silently repoint every profile already saved.
DEFAULT_ENDPOINT = TAVILY_ENDPOINT

TIMEOUT_SEC = 25.0
MAX_RESULTS = 5
#: Characters of per-result text kept. Tavily's extracts are long; Brave's
#: descriptions are a sentence or two and never reach this.
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


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    text: str
    #: Whether `text` is the page's own content or a search engine's summary of
    #: it. Carried through to what the model sees, because answering from a
    #: snippet as though it were the page is how a wrong quote gets confident.
    extracted: bool


class SearchAdapter(Protocol):
    """One search API. Adding another is a class here and a row in `ADAPTERS`."""

    id: str
    name: str
    #: Hostnames that identify this API. The endpoint's host *is* its identity:
    #: the request shape follows from it, so a separate "which adapter" setting
    #: could only ever disagree with the URL.
    hosts: tuple[str, ...]

    async def search(
        self, endpoint: SearchEndpoint, query: str, *, limit: int
    ) -> list[SearchHit]: ...


def _fail(status_code: int) -> ToolFailed:
    if status_code in (401, 403):
        return ToolFailed("bad_key", "the search endpoint rejected the API key")
    if status_code == 429:
        return ToolFailed(
            "rate_limited",
            "the search endpoint is rate limiting this key; wait and try again",
        )
    return ToolFailed("search_failed", f"the search endpoint answered {status_code}")


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError as exc:
        raise ToolFailed("search_failed", "the search endpoint did not return JSON") from exc
    return data if isinstance(data, dict) else {}


class TavilyAdapter:
    id = "tavily"
    name = "Tavily"
    hosts = ("api.tavily.com",)

    async def search(
        self, endpoint: SearchEndpoint, query: str, *, limit: int
    ) -> list[SearchHit]:
        payload = {
            "api_key": endpoint.api_key,
            "query": query,
            "max_results": limit,
            # The point of choosing this endpoint: text, not just links.
            "include_answer": False,
            "include_raw_content": False,
            "search_depth": "basic",
        }
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
                response = await client.post(f"{endpoint.base_url}/search", json=payload)
        except httpx.HTTPError as exc:
            raise ToolFailed(
                "search_failed", f"the search endpoint could not be reached: {exc}"
            ) from exc

        if response.status_code >= 400:
            raise _fail(response.status_code)

        return [
            SearchHit(
                title=str(item.get("title") or "").strip(),
                url=str(item.get("url") or "").strip(),
                text=str(item.get("content") or "").strip()[:MAX_RESULT_CHARS],
                extracted=True,
            )
            for item in (_json(response).get("results") or [])[:limit]
        ]


class BraveAdapter:
    id = "brave"
    name = "Brave Search"
    hosts = ("api.search.brave.com",)

    async def search(
        self, endpoint: SearchEndpoint, query: str, *, limit: int
    ) -> list[SearchHit]:
        # A GET with the key in a header, not a POST with the key in the body:
        # the two APIs are not the same shape, and pretending they were is what
        # §15 row 17 rules out for model providers as well.
        headers = {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": endpoint.api_key,
        }
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
                response = await client.get(
                    f"{endpoint.base_url}/res/v1/web/search",
                    params={"q": query, "count": limit},
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            raise ToolFailed(
                "search_failed", f"the search endpoint could not be reached: {exc}"
            ) from exc

        if response.status_code >= 400:
            raise _fail(response.status_code)

        results = (_json(response).get("web") or {}).get("results") or []
        return [
            SearchHit(
                title=str(item.get("title") or "").strip(),
                url=str(item.get("url") or "").strip(),
                # `description` is a snippet built by the search engine, not the
                # page. Marked as such rather than presented as content.
                text=str(item.get("description") or "").strip()[:MAX_RESULT_CHARS],
                extracted=False,
            )
            for item in results[:limit]
        ]


ADAPTERS: tuple[SearchAdapter, ...] = (TavilyAdapter(), BraveAdapter())


def adapter_for(base_url: str | None) -> SearchAdapter:
    """Which API a base URL belongs to.

    Chosen from the host, so the profile cannot hold a URL and a contradicting
    "type". An unknown host is refused by name rather than guessed at: sending
    Tavily's body to something else would produce a failure that reads like a
    key problem.
    """
    host = (urlparse(base_url or DEFAULT_ENDPOINT).hostname or "").lower()
    for adapter in ADAPTERS:
        if host in adapter.hosts:
            return adapter
    known = ", ".join(h for a in ADAPTERS for h in a.hosts)
    raise ToolFailed(
        "unknown_search_endpoint",
        f"{host or base_url!r} is not a search endpoint this build knows; known: {known}",
    )


def supported() -> list[dict[str, str]]:
    """What the UI offers when someone adds a search endpoint."""
    return [
        {"id": a.id, "name": a.name, "baseUrl": f"https://{a.hosts[0]}"} for a in ADAPTERS
    ]


def _render(hits: list[SearchHit]) -> str:
    blocks: list[str] = []
    for hit in hits:
        label = "" if hit.extracted else " (search-engine summary, not the page)"
        blocks.append(f"## {hit.title}{label}\n{hit.url}\n\n{hit.text}")
    return "\n\n---\n\n".join(blocks)


async def web_search(ctx: ToolContext, *, query: str) -> ToolResult:
    """Search the web and return results, marked as untrusted."""
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

    adapter = adapter_for(endpoint.base_url)
    hits = await adapter.search(endpoint, query, limit=MAX_RESULTS)

    if not hits:
        return ToolResult(
            content=f"No results for {query!r}.",
            summary=f"searched for {query!r}: nothing found",
            details={"results": 0, "engine": adapter.id},
        )

    body = _render(hits)
    if not any(hit.extracted for hit in hits):
        # Said once, plainly: these are summaries. An agent that answers from a
        # snippet as though it had read the page is how a confident wrong quote
        # happens.
        body += (
            "\n\n---\n\nThese are search-engine summaries, not page text. "
            "Use web_fetch on a URL above before quoting or relying on details."
        )

    return ToolResult(
        content=as_untrusted(f"a {adapter.name} search for {query!r}", body),
        summary=f"searched {adapter.name} for {query!r}: {len(hits)} result(s)",
        details={"results": len(hits), "engine": adapter.id},
    )


async def probe(endpoint: SearchEndpoint) -> tuple[bool, str]:
    """One real search, to check the key before a mission depends on it.

    The same shape as the model probe (§3.1): asked, not assumed. A key that is
    wrong should be found here rather than three minutes into a run.
    """
    try:
        adapter = adapter_for(endpoint.base_url)
    except ToolFailed as exc:
        return False, exc.message

    try:
        hits = await adapter.search(endpoint, "agent studio connectivity check", limit=1)
    except ToolFailed as exc:
        return False, exc.message
    return True, f"{adapter.name} works ({len(hits)} result(s) for a test query)"
