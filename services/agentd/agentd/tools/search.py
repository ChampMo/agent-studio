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
class QuotaWindow:
    """One allowance an endpoint reported about itself.

    An endpoint can declare several at once — Brave sends a per-second cap and a
    per-month one in the same headers — so this is a window, not "the quota".
    `window_sec` is what makes them tellable apart, and what decides which is
    worth showing a person: a monthly allowance is something you budget against,
    a per-second cap is not.

    Two fields exist because the endpoints genuinely differ. `window_sec` is
    None when a total came back with **no period** — Tavily's `/usage` does
    exactly that, and writing "a month" there because its dashboard says so
    would be this app asserting something the API never returned (§3.1). `unit`
    is what is counted: Brave meters requests, Tavily meters credits, and a
    search is one credit while a crawl is not.
    """

    limit: int
    remaining: int
    #: Seconds the window covers, from the endpoint's own declaration. None when
    #: it stated a total without saying over what period.
    window_sec: int | None
    #: Seconds until it refills, when the endpoint said.
    reset_sec: int | None = None
    #: What the numbers count, plural, for the sentence that shows them.
    unit: str = "requests"


@dataclass(frozen=True)
class SearchResponse:
    """What one search returned, and what the endpoint said about itself.

    `quota` is None for an endpoint that says nothing on a search — a fact about
    that response, not a zero, and not the last word either: some endpoints
    answer the question somewhere else (see `read_quota`).
    """

    hits: list[SearchHit]
    quota: tuple[QuotaWindow, ...] | None = None


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
    ) -> SearchResponse: ...

    async def read_quota(
        self, endpoint: SearchEndpoint
    ) -> tuple[QuotaWindow, ...] | None:
        """The allowance, when it takes a request of its own to find out.

        Brave reports on the way past, in headers on every search, so it has
        nothing to do here. Tavily reports nothing on a search and answers at
        `/usage` instead. Neither is smoothed into the other (§15 row 17): the
        caller asks for the search first and only comes here if that told it
        nothing.

        Every adapter implements this, including the one that returns None.
        Adapters match this `Protocol` structurally rather than inheriting from
        it, so a body written here would be documentation and not a default — a
        missing method is an `AttributeError` at the call site.
        """
        ...


def _fail(status_code: int) -> ToolFailed:
    if status_code in (401, 403):
        return ToolFailed("bad_key", "the search endpoint rejected the API key")
    if status_code == 402:
        return ToolFailed(
            "quota_exhausted", "this search key is out of credit for the period"
        )
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

        # A search carries no allowance: Tavily sends no rate-limit header and no
        # credit field in the body. It answers that at `/usage` instead, which is
        # what `read_quota` below is for. Both established against the live API
        # rather than read about.
        return SearchResponse(
            hits=[
                SearchHit(
                    title=str(item.get("title") or "").strip(),
                    url=str(item.get("url") or "").strip(),
                    text=str(item.get("content") or "").strip()[:MAX_RESULT_CHARS],
                    extracted=True,
                )
                for item in (_json(response).get("results") or [])[:limit]
            ]
        )

    async def read_quota(
        self, endpoint: SearchEndpoint
    ) -> tuple[QuotaWindow, ...] | None:
        """`GET /usage`, where Tavily keeps the number its dashboard draws.

        Two figures come back, the key's and the account plan's. The key's is
        reported, because this panel is about *this key*: an account whose plan
        has room is no help when the key itself is capped.

        **Credits, and no period.** A search costs one credit and a crawl does
        not, so calling them searches would be wrong the moment an agent uses
        another Tavily tool. And the response states a total with no window —
        the dashboard calls it a monthly plan, but the dashboard is not the API,
        and copying a period across is asserting something nobody returned.
        """
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
                response = await client.get(
                    f"{endpoint.base_url}/usage",
                    headers={"Authorization": f"Bearer {endpoint.api_key}"},
                )
        except httpx.HTTPError:
            # Not knowing the allowance is no reason to call a working key
            # broken. The caller records "nothing measured", which is its own
            # state and reads as such.
            return None
        if response.status_code >= 400:
            return None

        key = _json(response).get("key") or {}
        try:
            limit = int(key["limit"])
            used = int(key["usage"])
        except (KeyError, TypeError, ValueError):
            return None
        if limit <= 0:
            return None
        return (
            QuotaWindow(
                limit=limit,
                remaining=max(0, limit - used),
                window_sec=None,
                unit="credits",
            ),
        )


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
        return SearchResponse(
            hits=[
                SearchHit(
                    title=str(item.get("title") or "").strip(),
                    url=str(item.get("url") or "").strip(),
                    # `description` is a snippet built by the search engine, not
                    # the page. Marked as such, not presented as content.
                    text=str(item.get("description") or "").strip()[:MAX_RESULT_CHARS],
                    extracted=False,
                )
                for item in results[:limit]
            ],
            quota=brave_quota(response.headers),
        )

    async def read_quota(
        self, endpoint: SearchEndpoint
    ) -> tuple[QuotaWindow, ...] | None:
        """Nothing to do: Brave reports on the way past, in the headers of every
        search, so the allowance is already on the `SearchResponse`.

        There is also nowhere else to look. Every plausible account or usage path
        under `api.search.brave.com` answers 301 to the dashboard — tried, not
        assumed — and the open feature request asking Brave for such an endpoint
        is unanswered. A postpaid plan's ceiling is a *spend* limit in dollars,
        and no API returns it: the same wall as provider pricing (§6.2).
        """
        return None


def _numbers(raw: str | None) -> list[int]:
    """`"50, 0"` -> `[50, 0]`, skipping anything that is not a number."""
    out: list[int] = []
    for part in (raw or "").split(","):
        try:
            out.append(int(part.strip()))
        except ValueError:
            continue
    return out


def brave_quota(headers: Any) -> tuple[QuotaWindow, ...] | None:
    """Brave's allowances, read off the headers it sends with every answer.

        x-ratelimit-policy:    50;w=1, 0;w=2592000
        x-ratelimit-limit:     50, 0
        x-ratelimit-remaining: 49, 0
        x-ratelimit-reset:     1, 2462826

    The three value headers are positional lists matching the policy, so the
    window lengths come from the policy and nowhere else — a build that guessed
    "the second one is the month" would be wrong the day Brave adds a third.

    Anything that does not line up is dropped rather than half-read: a window
    whose length is unknown cannot be labelled, and an unlabelled meter is a
    number with no unit.
    """
    policy = str(headers.get("x-ratelimit-policy") or "")
    limits = _numbers(headers.get("x-ratelimit-limit"))
    remaining = _numbers(headers.get("x-ratelimit-remaining"))
    resets = _numbers(headers.get("x-ratelimit-reset"))
    if not policy or not limits:
        return None

    windows: list[QuotaWindow] = []
    for i, clause in enumerate(policy.split(",")):
        _, _, spec = clause.strip().partition(";w=")
        try:
            window_sec = int(spec.strip())
        except ValueError:
            continue
        if i >= len(limits) or i >= len(remaining):
            continue
        windows.append(
            QuotaWindow(
                limit=limits[i],
                remaining=remaining[i],
                window_sec=window_sec,
                reset_sec=resets[i] if i < len(resets) else None,
                unit="requests",
            )
        )
    return tuple(windows) or None


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


def _name_of(endpoint: SearchEndpoint) -> str:
    """A name for an endpoint, even one this build does not recognise."""
    try:
        return adapter_for(endpoint.base_url).name
    except ToolFailed:
        return endpoint.base_url


def _render(hits: list[SearchHit]) -> str:
    blocks: list[str] = []
    for hit in hits:
        label = "" if hit.extracted else " (search-engine summary, not the page)"
        blocks.append(f"## {hit.title}{label}\n{hit.url}\n\n{hit.text}")
    return "\n\n---\n\n".join(blocks)


def configured(ctx: ToolContext) -> list[SearchEndpoint]:
    """The search endpoints this mission may use, in the order to try them.

    A list rather than one, because the reason to have two is that the first
    runs out: Brave's free tier is a monthly allowance and a query a second.
    The order is the order they were added, which is the only ordering the user
    already controls and can see.
    """
    value = ctx.extras.get("search")
    if isinstance(value, SearchEndpoint):
        return [value]
    return [e for e in (value or []) if isinstance(e, SearchEndpoint)]


async def web_search(ctx: ToolContext, *, query: str) -> ToolResult:
    """Search the web and return results, marked as untrusted.

    With more than one endpoint configured, a key that is rate limited or out of
    credit moves to the next one rather than failing the call. What it does not
    do is hide that: the result says which engine answered, and an endpoint that
    was skipped says why in the summary.
    """
    endpoints = configured(ctx)
    if not endpoints:
        # Unreachable when the registry filtering is working: this tool is only
        # in a toolbox when a key exists.
        raise ToolFailed(
            "no_search_provider",
            "no search endpoint is configured, so the web cannot be searched",
        )
    if not query or not query.strip():
        raise ToolFailed("empty_query", "a search query is required")

    adapter: SearchAdapter | None = None
    hits: list[SearchHit] = []
    skipped: list[str] = []
    last: ToolFailed | None = None

    # One rule, for every kind of failure: try the next endpoint, and carry the
    # reason with whatever comes back. Falling over only on a quota error would
    # mean a revoked key takes down a search that another key could have served;
    # falling over silently would mean a key that stopped working is never
    # noticed. So it always moves on, and it always says so (§1).
    for endpoint in endpoints:
        try:
            candidate = adapter_for(endpoint.base_url)
            hits = (await candidate.search(endpoint, query, limit=MAX_RESULTS)).hits
        except ToolFailed as failure:
            skipped.append(f"{_name_of(endpoint)}: {failure.message}")
            last = failure
            continue
        adapter = candidate
        break

    if adapter is None:
        # Nothing answered. Every reason is reported rather than only the last
        # one tried, because "Tavily is out of credit" and "the Brave key was
        # rejected" need different fixes.
        assert last is not None
        raise ToolFailed(
            last.code, "; ".join(skipped) if len(skipped) > 1 else last.message
        )

    if not hits:
        return ToolResult(
            content=f"No results for {query!r}.",
            summary=f"searched {adapter.name} for {query!r}: nothing found",
            details={"results": 0, "engine": adapter.id, "fellBackPast": len(skipped)},
        )

    body = _render(hits)
    if skipped:
        # The fallback is on the record. A silent switch would make two runs
        # that used different engines look identical (§1).
        body += "\n\n---\n\nTried first, without success: " + "; ".join(skipped)
    if not any(hit.extracted for hit in hits):
        # Said once, plainly: these are summaries. An agent that answers from a
        # snippet as though it had read the page is how a confident wrong quote
        # happens.
        body += (
            "\n\n---\n\nThese are search-engine summaries, not page text. "
            "Use web_fetch on a URL above before quoting or relying on details."
        )

    summary = f"searched {adapter.name} for {query!r}: {len(hits)} result(s)"
    if skipped:
        summary += f" (fell back past {len(skipped)})"
    return ToolResult(
        content=as_untrusted(f"a {adapter.name} search for {query!r}", body),
        summary=summary,
        details={"results": len(hits), "engine": adapter.id, "fellBackPast": len(skipped)},
    )


async def probe(
    endpoint: SearchEndpoint,
) -> tuple[bool, str, tuple[QuotaWindow, ...] | None]:
    """One real search, to check the key before a mission depends on it.

    The same shape as the model probe (§3.1): asked, not assumed. A key that is
    wrong should be found here rather than three minutes into a run.

    It also brings back whatever the endpoint says about its own allowance. That
    answer has no place of its own to live — Brave attaches it to the response of
    a real search, Tavily keeps it behind another request — so the number a
    person sees is a measurement taken at a moment they can name, the same moment
    as "last tested", rather than a gauge pretending to be live.
    """
    try:
        adapter = adapter_for(endpoint.base_url)
    except ToolFailed as exc:
        return False, exc.message, None

    try:
        answer = await adapter.search(endpoint, "agent studio connectivity check", limit=1)
    except ToolFailed as exc:
        return False, exc.message, None

    # The search first, because it is the check; the extra call only when the
    # search said nothing. Brave answers in headers and never reaches line two.
    quota = answer.quota
    if quota is None:
        quota = await adapter.read_quota(endpoint)

    return (
        True,
        f"{adapter.name} works ({len(answer.hits)} result(s) for a test query)",
        quota,
    )
