"""Provider profiles and the keychain (PROJECT_BRIEF.md §3.1, §3.2, §9.2).

The key never crosses this boundary in the outbound direction. It comes in once,
goes straight to the OS keychain, and after that the API only ever reports
whether one exists. There is no endpoint that returns a key, by construction —
not even a masked one, because a masked key still confirms its prefix.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..core import secrets
from ..db.models import ProviderProfile
from ..providers import registry
from ..providers.base import ProviderError
from ..providers.probe import run_probe
from ..tools.search import DEFAULT_ENDPOINT as DEFAULT_SEARCH_ENDPOINT
from ..tools.search import SearchEndpoint
from ..tools.search import probe as search_probe
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
            await s.execute(select(ProviderProfile).order_by(ProviderProfile.created_at))
        ).scalars().all()
    return {
        "providers": [registry.profile_to_json(p) for p in rows],
        # `search` is not an LLM provider and has no factory in the provider
        # registry — it is an endpoint `web_search` uses (§16.5). Advertised
        # here so the UI can offer it; kept out of `available_kinds()` so
        # nothing tries to build a chat client from one.
        "kinds": [*registry.available_kinds(), "search"],
    }


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

        changed_target = False
        if body.name is not None:
            profile.name = body.name
        if body.model is not None and body.model != profile.model:
            profile.model = body.model
            changed_target = True
        if body.base_url != profile.base_url:
            profile.base_url = body.base_url
            changed_target = True

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
        ok, detail = await search_probe(
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
