"""Team CRUD, duplication, export and import (PROJECT_BRIEF.md §5.2, §5.3)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select

from ..agents.avatar import validate_avatar
from ..db.models import Agent, Team, TeamMember
from ..db.session import Database
from . import layouts
from .validator import Finding, can_run, validate

#: Bumped only for a change that older builds cannot read. Additive fields do
#: not bump it — an importer must ignore what it does not recognise (§8).
EXPORT_VERSION = 1


class TeamNotFound(LookupError):
    pass


class ImportRejected(ValueError):
    pass


class TeamService:
    def __init__(self, db: Database) -> None:
        self._db = db

    # ---- reads --------------------------------------------------------

    async def list(self, *, include_archived: bool = False) -> list[Team]:
        stmt = select(Team).order_by(Team.created_at.desc())
        if not include_archived:
            stmt = stmt.where(Team.archived_at.is_(None))
        async with self._db.session() as s:
            return list((await s.execute(stmt)).scalars().all())

    async def get(self, team_id: str) -> Team:
        async with self._db.session() as s:
            team = (
                await s.execute(select(Team).where(Team.id == team_id))
            ).scalar_one_or_none()
        if team is None:
            raise TeamNotFound(team_id)
        return team

    async def members(self, team_id: str) -> list[TeamMember]:
        async with self._db.session() as s:
            rows = await s.execute(
                select(TeamMember)
                .where(TeamMember.team_id == team_id)
                .order_by(TeamMember.seat_index)
            )
            return list(rows.scalars().all())

    async def _agents_for(self, members: list[TeamMember]) -> dict[str, Agent]:
        if not members:
            return {}
        ids = [m.agent_id for m in members]
        async with self._db.session() as s:
            rows = await s.execute(select(Agent).where(Agent.id.in_(ids)))
            return {a.id: a for a in rows.scalars().all()}

    async def validate(
        self, team_id: str, *, known_tools: set[str] | None = None
    ) -> list[Finding]:
        team = await self.get(team_id)
        members = await self.members(team_id)
        return validate(
            layout_id=team.scene_layout_id,
            members=members,
            agents=await self._agents_for(members),
            known_tools=known_tools,
        )

    async def to_json(self, team: Team) -> dict[str, Any]:
        members = await self.members(team.id)
        agents = await self._agents_for(members)
        findings = validate(
            layout_id=team.scene_layout_id, members=members, agents=agents
        )
        return {
            "id": team.id,
            "name": team.name,
            "description": team.description,
            "emblemConfig": team.emblem_config,
            "sceneLayoutId": team.scene_layout_id,
            "defaultBudget": team.default_budget,
            "sourceId": team.source_id,
            "archivedAt": team.archived_at.isoformat() if team.archived_at else None,
            "createdAt": team.created_at.isoformat(),
            "updatedAt": team.updated_at.isoformat(),
            "members": [
                {
                    "agentId": m.agent_id,
                    "seatIndex": m.seat_index,
                    "roleInTeam": m.role_in_team,
                    "overrides": m.overrides,
                    "agentName": agents[m.agent_id].name if m.agent_id in agents else None,
                    "agentArchived": (
                        agents[m.agent_id].archived_at is not None
                        if m.agent_id in agents
                        else None
                    ),
                }
                for m in members
            ],
            "findings": [f.to_json() for f in findings],
            # The save/run split, computed from the one finding list (§5.2).
            "canRun": can_run(findings),
        }

    # ---- writes -------------------------------------------------------

    async def create(self, fields: dict[str, Any]) -> Team:
        now = datetime.now(UTC)
        team = Team(
            id=f"team-{uuid.uuid4()}",
            name=fields["name"],
            description=fields.get("description", ""),
            emblem_config=fields.get("emblem_config") or {},
            scene_layout_id=fields.get("scene_layout_id") or layouts.DEFAULT_LAYOUT,
            default_budget=fields.get("default_budget") or {},
            source_id=fields.get("source_id"),
            created_at=now,
            updated_at=now,
        )
        async with self._db.session() as s:
            s.add(team)
            await s.commit()
        if fields.get("members") is not None:
            await self.set_members(team.id, fields["members"])
        return team

    async def update(self, team_id: str, changes: dict[str, Any]) -> Team:
        async with self._db.session() as s:
            team = (
                await s.execute(select(Team).where(Team.id == team_id))
            ).scalar_one_or_none()
            if team is None:
                raise TeamNotFound(team_id)
            for key in (
                "name",
                "description",
                "emblem_config",
                "scene_layout_id",
                "default_budget",
            ):
                if key in changes:
                    setattr(team, key, changes[key])
            team.updated_at = datetime.now(UTC)
            await s.commit()
        if "members" in changes:
            await self.set_members(team_id, changes["members"])
        return await self.get(team_id)

    async def set_members(self, team_id: str, members: list[dict[str, Any]]) -> None:
        """Replace the whole roster in one transaction.

        Wholesale rather than incremental because seats and the leader flag are
        unique per team: swapping two members one row at a time transiently
        violates both constraints, and there is no ordering of individual
        updates that avoids it.
        """
        async with self._db.session() as s:
            await s.execute(delete(TeamMember).where(TeamMember.team_id == team_id))
            for member in members:
                s.add(
                    TeamMember(
                        team_id=team_id,
                        agent_id=member["agent_id"],
                        seat_index=int(member["seat_index"]),
                        role_in_team=member.get("role_in_team", "member"),
                        overrides=member.get("overrides"),
                    )
                )
            await s.commit()

    async def archive(self, team_id: str) -> Team:
        async with self._db.session() as s:
            team = (
                await s.execute(select(Team).where(Team.id == team_id))
            ).scalar_one_or_none()
            if team is None:
                raise TeamNotFound(team_id)
            team.archived_at = datetime.now(UTC)
            team.updated_at = team.archived_at
            await s.commit()
        return team

    async def delete(self, team_id: str) -> None:
        """Remove the team and its seats.

        Safe for the same reason deleting an agent is: a mission froze its
        roster at launch (§5.1), so a replay still knows who sat where. What
        goes is the arrangement, not the record of what it once did.

        `missions.team_id` is left pointing at an id that no longer resolves.
        That is deliberate — the mission row records which team ran it, and
        rewriting that to null would be editing history to keep a foreign key
        tidy.
        """
        async with self._db.session() as s:
            team = (
                await s.execute(select(Team).where(Team.id == team_id))
            ).scalar_one_or_none()
            if team is None:
                raise TeamNotFound(team_id)
            await s.execute(delete(TeamMember).where(TeamMember.team_id == team_id))
            await s.delete(team)
            await s.commit()

    async def restore(self, team_id: str) -> Team:
        async with self._db.session() as s:
            team = (
                await s.execute(select(Team).where(Team.id == team_id))
            ).scalar_one_or_none()
            if team is None:
                raise TeamNotFound(team_id)
            team.archived_at = None
            team.updated_at = datetime.now(UTC)
            await s.commit()
        return team

    async def duplicate(self, team_id: str) -> Team:
        """Copy a team. The members are the *same* agents, not copies: agents
        are many-to-many with teams by design (§5)."""
        source = await self.get(team_id)
        members = await self.members(team_id)
        copy = await self.create(
            {
                "name": f"{source.name} (copy)",
                "description": source.description,
                "emblem_config": dict(source.emblem_config),
                "scene_layout_id": source.scene_layout_id,
                "default_budget": dict(source.default_budget),
            }
        )
        await self.set_members(
            copy.id,
            [
                {
                    "agent_id": m.agent_id,
                    "seat_index": m.seat_index,
                    "role_in_team": m.role_in_team,
                    "overrides": m.overrides,
                }
                for m in members
            ],
        )
        return copy

    # ---- export / import ----------------------------------------------

    async def export(self, team_id: str) -> dict[str, Any]:
        """One self-contained JSON document (§5.3).

        Agent definitions travel with the team, because the recipient will not
        have them. What deliberately does **not** travel:

        * any API key — there is none to leak here, since keys live only in the
          keychain and never reach a row (§9.2), and a test asserts it anyway;
        * `provider_id` — a local row id that means nothing on another machine.
          `model` is kept as a hint so the importer knows what it was built for.
        """
        team = await self.get(team_id)
        members = await self.members(team_id)
        agents = await self._agents_for(members)

        return {
            "schema_version": EXPORT_VERSION,
            "kind": "agent-studio.team",
            "exported_at": datetime.now(UTC).isoformat(),
            "team": {
                "source_id": team.id,
                "name": team.name,
                "description": team.description,
                "emblem_config": team.emblem_config,
                "scene_layout_id": team.scene_layout_id,
                "default_budget": team.default_budget,
            },
            "members": [
                {
                    "agent_source_id": m.agent_id,
                    "seat_index": m.seat_index,
                    "role_in_team": m.role_in_team,
                    "overrides": m.overrides,
                }
                for m in members
            ],
            "agents": [
                {
                    "source_id": a.id,
                    "name": a.name,
                    "title": a.title,
                    "role": a.role,
                    "backstory": a.backstory,
                    "personality_traits": a.personality_traits,
                    "system_prompt": a.system_prompt,
                    "model": a.model,
                    "sampling": a.sampling,
                    "tools": a.tools,
                    "avatar_config": a.avatar_config,
                }
                for a in (agents[m.agent_id] for m in members if m.agent_id in agents)
            ],
        }

    async def import_(self, document: dict[str, Any]) -> dict[str, Any]:
        """Bring a team in under fresh ids (§5.3).

        Always new ids, never overwriting: an import that replaced a same-named
        agent would silently destroy work the user had done to it. `source_id`
        records where each row came from so a second import of the same file is
        recognisable rather than indistinguishable.
        """
        if document.get("kind") != "agent-studio.team":
            raise ImportRejected("this file is not an Agent Studio team export")

        version = document.get("schema_version")
        if not isinstance(version, int) or version > EXPORT_VERSION:
            raise ImportRejected(
                f"the file was written by a newer version (schema_version={version}); "
                f"this build understands up to {EXPORT_VERSION}"
            )

        now = datetime.now(UTC)
        id_map: dict[str, str] = {}
        incoming = document.get("agents") or []

        async with self._db.session() as s:
            for spec in incoming:
                new_id = f"agent-{uuid.uuid4()}"
                id_map[spec.get("source_id", new_id)] = new_id
                s.add(
                    Agent(
                        id=new_id,
                        name=spec.get("name", "Imported agent"),
                        title=spec.get("title", ""),
                        role=spec.get("role", ""),
                        backstory=spec.get("backstory", ""),
                        personality_traits=spec.get("personality_traits") or [],
                        system_prompt=spec.get("system_prompt", ""),
                        # Left unset on purpose: provider ids are local, and the
                        # user picks one after import.
                        provider_id=None,
                        model=spec.get("model"),
                        sampling=spec.get("sampling"),
                        tools=spec.get("tools") or [],
                        avatar_config=validate_avatar(spec.get("avatar_config") or {}),
                        total_missions=0,
                        source_id=spec.get("source_id"),
                        created_at=now,
                        updated_at=now,
                    )
                )
            await s.commit()

        spec = document.get("team") or {}
        team = await self.create(
            {
                "name": spec.get("name", "Imported team"),
                "description": spec.get("description", ""),
                "emblem_config": spec.get("emblem_config") or {},
                "scene_layout_id": spec.get("scene_layout_id") or layouts.DEFAULT_LAYOUT,
                "default_budget": spec.get("default_budget") or {},
                "source_id": spec.get("source_id"),
            }
        )

        members = [
            {
                "agent_id": id_map[m["agent_source_id"]],
                "seat_index": m.get("seat_index", i),
                "role_in_team": m.get("role_in_team", "member"),
                "overrides": m.get("overrides"),
            }
            for i, m in enumerate(document.get("members") or [])
            if m.get("agent_source_id") in id_map
        ]
        await self.set_members(team.id, members)

        return {"team_id": team.id, "agent_ids": list(id_map.values())}

    async def find_by_source(self, source_id: str) -> list[Team]:
        """Teams that came from this export before. The UI asks so it can offer
        a choice instead of quietly creating a duplicate (§5.3)."""
        async with self._db.session() as s:
            rows = await s.execute(select(Team).where(Team.source_id == source_id))
            return list(rows.scalars().all())
