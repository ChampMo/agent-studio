"""Agent CRUD (PROJECT_BRIEF.md §5, §5.2)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from ..db.models import Agent
from ..db.session import Database
from .avatar import default_avatar, validate_avatar
from .exp import progress


class AgentNotFound(LookupError):
    pass


def to_json(agent: Agent) -> dict[str, Any]:
    """The wire form. `level` is computed here and never stored (§5)."""
    return {
        "id": agent.id,
        "name": agent.name,
        "title": agent.title,
        "role": agent.role,
        "backstory": agent.backstory,
        "personalityTraits": agent.personality_traits,
        "systemPrompt": agent.system_prompt,
        "providerId": agent.provider_id,
        "model": agent.model,
        "sampling": agent.sampling,
        "tools": agent.tools,
        "avatarConfig": agent.avatar_config,
        "totalMissions": agent.total_missions,
        "archivedAt": agent.archived_at.isoformat() if agent.archived_at else None,
        "createdAt": agent.created_at.isoformat(),
        "updatedAt": agent.updated_at.isoformat(),
        **progress(agent.exp),
    }


class AgentService:
    #: Fields the API may write. `exp`, `total_missions` and the timestamps are
    #: absent on purpose: they are earned or set by the system, and letting a
    #: PATCH touch them would make the roster a place to award yourself levels.
    EDITABLE = {
        "name",
        "title",
        "role",
        "backstory",
        "personality_traits",
        "system_prompt",
        "provider_id",
        "model",
        "sampling",
        "tools",
        "avatar_config",
    }

    def __init__(self, db: Database) -> None:
        self._db = db

    async def list(self, *, include_archived: bool = False) -> list[Agent]:
        stmt = select(Agent).order_by(Agent.created_at.desc())
        if not include_archived:
            stmt = stmt.where(Agent.archived_at.is_(None))
        async with self._db.session() as s:
            return list((await s.execute(stmt)).scalars().all())

    async def get(self, agent_id: str) -> Agent:
        async with self._db.session() as s:
            agent = (
                await s.execute(select(Agent).where(Agent.id == agent_id))
            ).scalar_one_or_none()
        if agent is None:
            raise AgentNotFound(agent_id)
        return agent

    async def create(self, fields: dict[str, Any]) -> Agent:
        now = datetime.now(UTC)
        avatar = fields.get("avatar_config") or default_avatar()
        agent = Agent(
            id=f"agent-{uuid.uuid4()}",
            name=fields["name"],
            title=fields.get("title", ""),
            role=fields.get("role", ""),
            backstory=fields.get("backstory", ""),
            personality_traits=fields.get("personality_traits") or [],
            system_prompt=fields.get("system_prompt", ""),
            provider_id=fields.get("provider_id"),
            model=fields.get("model"),
            sampling=fields.get("sampling"),
            tools=fields.get("tools") or [],
            # Validated even on the way in from the UI: the generator is not the
            # only path to this table, and an unknown asset breaks the scene in
            # M5 wherever it came from (§11).
            avatar_config=validate_avatar(avatar),
            exp=0,
            total_missions=0,
            created_at=now,
            updated_at=now,
        )
        async with self._db.session() as s:
            s.add(agent)
            await s.commit()
        return agent

    async def update(self, agent_id: str, changes: dict[str, Any]) -> Agent:
        rejected = set(changes) - self.EDITABLE
        if rejected:
            raise ValueError(f"not editable: {', '.join(sorted(rejected))}")

        async with self._db.session() as s:
            agent = (
                await s.execute(select(Agent).where(Agent.id == agent_id))
            ).scalar_one_or_none()
            if agent is None:
                raise AgentNotFound(agent_id)
            if "avatar_config" in changes:
                changes["avatar_config"] = validate_avatar(changes["avatar_config"])
            for key, value in changes.items():
                setattr(agent, key, value)
            agent.updated_at = datetime.now(UTC)
            await s.commit()
        return agent

    async def archive(self, agent_id: str) -> Agent:
        """Soft delete. A row this table hands out is referenced by teams and by
        finished missions; removing it would strand both (§5.2)."""
        async with self._db.session() as s:
            agent = (
                await s.execute(select(Agent).where(Agent.id == agent_id))
            ).scalar_one_or_none()
            if agent is None:
                raise AgentNotFound(agent_id)
            agent.archived_at = datetime.now(UTC)
            agent.updated_at = agent.archived_at
            await s.commit()
        return agent

    async def restore(self, agent_id: str) -> Agent:
        async with self._db.session() as s:
            agent = (
                await s.execute(select(Agent).where(Agent.id == agent_id))
            ).scalar_one_or_none()
            if agent is None:
                raise AgentNotFound(agent_id)
            agent.archived_at = None
            agent.updated_at = datetime.now(UTC)
            await s.commit()
        return agent

    async def duplicate(self, agent_id: str) -> Agent:
        """Copy an agent under a new id.

        This is the sanctioned way to freeze a configuration (§5): teams
        reference agents live and there is no versioning, so a user who wants
        the old behaviour kept takes a copy before editing. The copy starts at
        zero exp — it has not done the work.
        """
        source = await self.get(agent_id)
        return await self.create(
            {
                "name": f"{source.name} (copy)",
                "title": source.title,
                "role": source.role,
                "backstory": source.backstory,
                "personality_traits": list(source.personality_traits),
                "system_prompt": source.system_prompt,
                "provider_id": source.provider_id,
                "model": source.model,
                "sampling": source.sampling,
                "tools": list(source.tools),
                "avatar_config": dict(source.avatar_config),
            }
        )
