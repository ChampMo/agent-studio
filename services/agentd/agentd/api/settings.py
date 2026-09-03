"""Provider profiles and the keychain (PROJECT_BRIEF.md §3.1, §3.2, §9.2).

The key never crosses this boundary in the outbound direction. It comes in once,
goes straight to the OS keychain, and after that the API only ever reports
whether one exists. There is no endpoint that returns a key, by construction —
not even a masked one, because a masked key still confirms its prefix.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..core import secrets
from ..core.prefs import (
    AUTONOMY_CHOICES,
    BUDGET_BOUNDS,
    default_budget,
    get_app_budget,
    get_autonomy,
    set_app_budget,
    set_autonomy,
)
from ..db.models import ProviderProfile
from ..providers import registry
from ..providers.base import ProviderError
from ..providers.native_search import describe as native_search_endpoints
from ..providers.presets import describe as model_presets
from ..providers.native_search import supports_native_search
from ..providers.probe import run_probe
from ..tools.search import DEFAULT_ENDPOINT as DEFAULT_SEARCH_ENDPOINT
from ..tools.search import SearchEndpoint
from ..tools.search import probe as search_probe
from ..tools.search import supported as search_engines
from .deps import get_db, require_token

router = APIRouter(dependencies=[Depends(require_token)])


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["openai_compatible", "anthropic", "search"]
    model: str = Field(min_length=1)
    base_url: str | None = None


class ProfilePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, min_length=1)
    base_url: str | None = None
    #: Let the endpoint search the web itself (§16.8). Refused on an endpoint
    #: that does not support it, so the switch cannot be a setting that does
    #: nothing.
    native_search: bool | None = None


class KeyIn(BaseModel):
    key: str = Field(min_length=1)


async def _load(request: Request, profile_id: str) -> ProviderProfile:
    db = get_db(request)
    async with db.session() as s:
        profile = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.id == profile_id)
            )
        ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no provider profile {profile_id!r}")
    return profile


@router.get("/providers")
async def list_providers(request: Request) -> dict[str, Any]:
    db = get_db(request)
    async with db.session() as s:
        rows = (
            await s.execute(select(ProviderProfile).order_by(*registry.search_order()))
        ).scalars().all()
    return {
        "providers": [registry.profile_to_json(p) for p in rows],
        # `search` is not an LLM provider and has no factory in the provider
        # registry — it is an endpoint `web_search` uses (§16.5). Advertised
        # here so the UI can offer it; kept out of `available_kinds()` so
        # nothing tries to build a chat client from one.
        "kinds": [*registry.available_kinds(), "search"],
        # The search APIs this build can talk to, so the UI offers the right
        # base URLs instead of asking someone to remember them. Which adapter
        # runs is decided by the host (§16.5).
        "searchEngines": search_engines(),
        # Starting points for the add-a-model form: a base URL and whether a key
        # is usually wanted. Not model ids — those have a live answer at
        # `POST /providers/models`, and a shipped list goes stale in silence.
        "modelPresets": model_presets(),
    }


class ModelsIn(BaseModel):
    """An endpoint to ask, before anything about it is saved."""

    kind: Literal["openai_compatible", "anthropic"]
    base_url: str | None = None
    #: Optional: a server on this machine authenticates nothing.
    key: str | None = None


@router.post("/providers/models")
async def list_endpoint_models(request: Request, body: ModelsIn) -> dict[str, Any]:
    """The model ids this endpoint actually offers (§3.1).

    Typing a model id by hand is the step that goes wrong: it is a string with
    no feedback until a mission fails on it, and the only place the correct
    spelling exists is the endpoint. So this asks.

    **Nothing is stored, and the key is not one of the things stored.** It
    arrives in the body — never a query string (§9.1) — is handed to the SDK for
    one call, and is gone when this returns. A profile is created afterwards,
    separately, by the form that used this.

    A failure is returned rather than raised into a 500: an endpoint that does
    not implement `/models` is a normal thing to meet, and the form falls back
    to a text field rather than becoming unusable.
    """
    try:
        provider = registry.build(
            body.kind,
            api_key=body.key or registry.NO_KEY_NEEDED,
            base_url=body.base_url,
        )
    except ProviderError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, exc.message) from exc

    try:
        models = await provider.list_models()
    except ProviderError as exc:
        # The endpoint's own words. "Connection refused" and "invalid api key"
        # need different fixes, and flattening them to "could not list models"
        # would hide which one happened.
        return {"models": [], "error": exc.message}
    except Exception as exc:  # noqa: BLE001 - anything here is the endpoint's
        return {"models": [], "error": str(exc)}
    finally:
        await provider.aclose()

    return {"models": models, "error": None}


class SearchOrderIn(BaseModel):
    """Every search profile, in the order to try them."""

    ids: list[str]


@router.post("/providers/search-order")
async def set_search_order(request: Request, body: SearchOrderIn) -> dict[str, Any]:
    """Set which search key is tried first (§16.5).

    The whole chain at once, not one row at a time. Two reasons, and both were
    the deciding ones:

    * **A position is a statement about the others.** Moving Tavily to first
      also moves Brave to second, and a per-row PATCH would leave two rows
      briefly claiming the same place — with the runner reading the table in
      between.
    * **A partial list has no honest interpretation.** Sending two of three ids
      does not say where the third goes, and inventing a place for it is the
      app deciding something nobody asked it to.

    So the request must name exactly the configured search profiles: same set,
    no repeats, nothing missing. Anything else is a 400 that says which ids were
    wrong rather than silently doing its best.
    """
    db = get_db(request)
    async with db.session() as s:
        rows = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.kind == "search")
            )
        ).scalars().all()
        known = {row.id for row in rows}
        asked = list(body.ids)

        if len(set(asked)) != len(asked):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "the same endpoint appears twice in the order",
            )
        if set(asked) != known:
            missing = sorted(known - set(asked))
            unknown = sorted(set(asked) - known)
            detail = "the order must list every search endpoint exactly once"
            if missing:
                detail += f"; missing: {', '.join(missing)}"
            if unknown:
                detail += f"; not a search endpoint: {', '.join(unknown)}"
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail)

        by_id = {row.id: row for row in rows}
        for position, profile_id in enumerate(asked):
            by_id[profile_id].sort_order = position
        await s.commit()

    return {"ids": asked}


@router.post("/providers", status_code=status.HTTP_201_CREATED)
async def create_provider(request: Request, body: ProfileIn) -> dict[str, Any]:
    db = get_db(request)
    profile = ProviderProfile(
        id=f"prov-{uuid.uuid4()}",
        name=body.name,
        kind=body.kind,
        base_url=body.base_url,
        model=body.model,
        # Null until the probe has actually run. Nothing is assumed about an
        # endpoint we have not talked to (§3.1).
        capabilities=None,
        verified_at=None,
        created_at=datetime.now(UTC),
    )
    async with db.session() as s:
        s.add(profile)
        await s.commit()
    return registry.profile_to_json(profile)


@router.patch("/providers/{profile_id}")
async def update_provider(
    request: Request, profile_id: str, body: ProfilePatch
) -> dict[str, Any]:
    db = get_db(request)
    async with db.session() as s:
        profile = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.id == profile_id)
            )
        ).scalar_one_or_none()
        if profile is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such provider profile")

        # Which fields the caller actually sent, not which are non-null. They
        # are different questions for `base_url`: an Anthropic profile has none,
        # so null is a real value someone may mean. Treating "absent" as "set to
        # null" meant that renaming a profile erased its base URL and broke the
        # provider — quietly, and only noticed later.
        sent = body.model_fields_set

        changed_target = False
        if body.name is not None:
            profile.name = body.name
        if body.model is not None and body.model != profile.model:
            profile.model = body.model
            changed_target = True
        if "base_url" in sent and body.base_url != profile.base_url:
            profile.base_url = body.base_url
            changed_target = True

        if body.native_search is not None:
            # Refused rather than stored-and-ignored on an endpoint that cannot
            # do it: a switch that does nothing is worse than no switch, and
            # this one is about whether a gate applies (§16.8).
            if body.native_search and not supports_native_search(profile.base_url):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "this endpoint does not run web search itself; "
                    "it is available on: "
                    + ", ".join(e["baseUrl"] for e in native_search_endpoints()),
                )
            profile.native_search = body.native_search

        # Turning off native search when the base URL moves away from an
        # endpoint that supports it: the flag would otherwise stay on, pointing
        # at something that ignores it.
        if changed_target and not supports_native_search(profile.base_url):
            profile.native_search = False

        # Capabilities describe a model at an endpoint. Change either and the
        # old readings are about something else, so they are cleared rather
        # than left to be quietly wrong.
        if changed_target:
            profile.capabilities = None
            profile.verified_at = None

        await s.commit()
    return registry.profile_to_json(profile)


@router.delete("/providers/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(request: Request, profile_id: str) -> None:
    profile = await _load(request, profile_id)
    db = get_db(request)
    async with db.session() as s:
        await s.delete(await s.merge(profile))
        await s.commit()
    # The keychain entry goes with it; an orphaned secret is a secret nobody
    # remembers they still have.
    secrets.delete_key(profile_id)


@router.put("/providers/{profile_id}/key", status_code=status.HTTP_204_NO_CONTENT)
async def set_key(request: Request, profile_id: str, body: KeyIn) -> None:
    """Store a key. There is no matching GET, and there never will be."""
    await _load(request, profile_id)
    try:
        secrets.set_key(profile_id, body.key)
    except secrets.SecretsUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"OS keychain unavailable: {exc}"
        ) from exc


@router.delete("/providers/{profile_id}/key", status_code=status.HTTP_204_NO_CONTENT)
async def clear_key(request: Request, profile_id: str) -> None:
    await _load(request, profile_id)
    secrets.delete_key(profile_id)


@router.post("/providers/{profile_id}/test")
async def test_connection(request: Request, profile_id: str) -> dict[str, Any]:
    """Run the four probes and record what was observed (§3.1).

    Returns every check separately. A wrong model id and a model that cannot
    call tools are different problems with different fixes, and one combined
    verdict would hide which of them happened.
    """
    profile = await _load(request, profile_id)

    if profile.kind == "search":
        # A different endpoint answering a different question, so a different
        # probe: one real search, checking the key rather than the model.
        key = secrets.get_key(profile.id)
        if not key:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "no key in the keychain for this endpoint"
            )
        ok, detail, quota = await search_probe(
            SearchEndpoint(api_key=key, base_url=profile.base_url or DEFAULT_SEARCH_ENDPOINT)
        )
        if ok:
            db = get_db(request)
            async with db.session() as s:
                row = (
                    await s.execute(
                        select(ProviderProfile).where(ProviderProfile.id == profile_id)
                    )
                ).scalar_one()
                row.verified_at = datetime.now(UTC)
                # Written together with the timestamp, because the number is
                # only meaningful with the moment it was taken — and stored in
                # three states, not two. Null is *never measured*, which is
                # what every row tested before this column existed still is.
                # An empty list is *measured, and this endpoint reports none*,
                # which is the true and permanent answer for Tavily. Saying
                # "reports no allowance" about a key we never asked would be
                # our own gap written down as a fact about the world (§3.1).
                row.quota = [
                    {
                        "limit": w.limit,
                        "remaining": w.remaining,
                        "windowSec": w.window_sec,
                        "resetSec": w.reset_sec,
                        "unit": w.unit,
                    }
                    for w in (quota or ())
                ]
                await s.commit()
        return {
            "ok": ok,
            "counts": {"passed": int(ok), "failed": int(not ok), "inconclusive": 0, "total": 1},
            "checks": [
                {
                    "id": "search",
                    "label": "Search",
                    "status": "pass" if ok else "fail",
                    "ok": ok,
                    "detail": detail,
                }
            ],
            "capabilities": {},
            "conclusive": ["search"] if ok else [],
        }

    try:
        provider = registry.build_from_profile(profile)
    except ProviderError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, exc.message) from exc

    try:
        result = await run_probe(provider, profile.model)
    finally:
        await provider.aclose()

    db = get_db(request)
    async with db.session() as s:
        row = (
            await s.execute(
                select(ProviderProfile).where(ProviderProfile.id == profile_id)
            )
        ).scalar_one()
        if result.ok:
            # Merge only what this run actually established. An inconclusive
            # check — a reply cut off at max_tokens, say — proves nothing, and
            # writing its apparent result would turn our own bug into a
            # recorded fact about the model (§3.1). Previously stored findings
            # survive untouched.
            row.capabilities = {
                **(row.capabilities or {}),
                **result.conclusive_capabilities(),
            }
            row.verified_at = datetime.now(UTC)
        await s.commit()

    return result.to_json()


# ---- app preferences ----------------------------------------------------


class AutonomyIn(BaseModel):
    value: Literal["ask_always", "ask_dangerous", "trusted"]


class BudgetIn(BaseModel):
    max_tokens: int
    max_llm_calls: int
    max_supersteps: int
    timeout_sec: int


@router.get("/prefs/budget")
async def read_budget(request: Request) -> dict[str, Any]:
    """Where every run's ceilings come from (§10).

    These four numbers stopped runs from the first release and were editable
    from nowhere — a team could be killed at 200,000 tokens with no screen
    saying what that number was or how to change it.

    They are **this app's** limits, not the endpoint's. Nothing here is imposed
    by the provider; it is the point at which this app stops a run, and the
    panel says so in those words.

    The shipped values come back too, so "reset" can be offered without the UI
    keeping its own copy of them to drift.
    """
    current = await get_app_budget(get_db(request))
    shipped = default_budget()
    return {
        "value": current.as_dict() if hasattr(current, "as_dict") else {
            "max_tokens": current.max_tokens,
            "max_llm_calls": current.max_llm_calls,
            "max_supersteps": current.max_supersteps,
            "timeout_sec": current.timeout_sec,
        },
        "shipped": {
            "max_tokens": shipped.max_tokens,
            "max_llm_calls": shipped.max_llm_calls,
            "max_supersteps": shipped.max_supersteps,
            "timeout_sec": shipped.timeout_sec,
        },
        "bounds": {k: list(v) for k, v in BUDGET_BOUNDS.items()},
    }


@router.put("/prefs/budget")
async def write_budget(request: Request, body: BudgetIn) -> dict[str, Any]:
    try:
        await set_app_budget(get_db(request), body.model_dump())
    except ValueError as exc:
        # By name and with the range, so the field that is wrong is obvious.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return await read_budget(request)


@router.get("/storage")
async def read_storage(request: Request) -> dict[str, Any]:
    """Where this app keeps things, and how much of it there is.

    Asked often enough to be worth answering: the runs, the files agents wrote
    and the pictures attached to them all live in one folder nobody is ever
    shown. The path is the useful part — the window can open it — and the sizes
    say which part is actually large.

    Measured, not estimated. A folder that is not there yet reports zero rather
    than being omitted, because "no artifacts yet" and "no such thing" read very
    differently.
    """
    settings = request.app.state.settings
    root = Path(settings.data_dir)

    def measure(path: Path) -> dict[str, Any]:
        if not path.exists():
            return {"path": str(path), "exists": False, "bytes": 0, "files": 0}
        if path.is_file():
            return {"path": str(path), "exists": True, "bytes": path.stat().st_size, "files": 1}
        total = 0
        count = 0
        for item in path.rglob("*"):
            if item.is_file():
                try:
                    total += item.stat().st_size
                except OSError:
                    continue
                count += 1
        return {"path": str(path), "exists": True, "bytes": total, "files": count}

    return {
        "root": str(root),
        "parts": [
            {"id": "database", "label": "Runs and their timelines", **measure(root / "agent-studio.db")},
            {"id": "artifacts", "label": "Files agents produced", **measure(root / "artifacts")},
            {"id": "attachments", "label": "Pictures and files you attached", **measure(root / "attachments")},
        ],
    }


@router.get("/prefs/autonomy")
async def read_autonomy(request: Request) -> dict[str, Any]:
    """When a tool call stops to ask. One value for the whole app (§16.4).

    Frozen into each mission's snapshot at launch, so changing it mid-run does
    not change what that run is allowed to do.
    """
    return {
        "value": await get_autonomy(get_db(request)),
        "choices": list(AUTONOMY_CHOICES),
    }


@router.put("/prefs/autonomy")
async def write_autonomy(request: Request, body: AutonomyIn) -> dict[str, Any]:
    value = await set_autonomy(get_db(request), body.value)
    return {"value": value, "choices": list(AUTONOMY_CHOICES)}
