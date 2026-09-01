"""SQLAlchemy models.

All tables the app uses live here — but `missions` already carries the columns
those milestones depend on (`kind`, `roster_snapshot`, `end_reason`), because by
then the table holds real rows and adding them is a data migration rather than a
schema edit (PROJECT_BRIEF.md §5.1).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Mission(Base):
    """A unit of work. A plain chat is a degenerate mission (§15 row 4): it gets
    the timeline, the replay, the budget guard and the cancel button for free."""

    __tablename__ = "missions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    team_id: Mapped[str | None] = mapped_column(String, nullable=True)
    goal: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default="running")
    budget: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    #: Effective config resolved at start: identities, seats, models, overrides.
    #: While a mission runs, nothing may read `agents` or `team_members` — only
    #: this. Otherwise an edit mid-flight makes the timeline lie (§5.1).
    roster_snapshot: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)

    #: The question this mission is blocked on, if any. Lets an answer be
    #: routed without replaying the event log to find what was asked (§12 M6).
    pending_request: Mapped[str | None] = mapped_column(String, nullable=True)

    #: The only folder this mission's file tools may touch (§16.2). On the
    #: mission rather than the team, because one team has to be usable on
    #: several projects (§15 row 29). Null for a chat, and for a team that
    #: carries no file tool.
    workspace_root: Mapped[str | None] = mapped_column(Text, nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint("kind IN ('chat', 'mission')", name="ck_missions_kind"),
        Index("ix_missions_started_at", "started_at"),
    )


class MissionEvent(Base):
    """Append-only, forever. Never UPDATE, never DELETE — the replay in M6 and
    every audit of what actually happened read straight off this table."""

    __tablename__ = "mission_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    mission_id: Mapped[str] = mapped_column(
        String, ForeignKey("missions.id", ondelete="RESTRICT"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    v: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)

    __table_args__ = (
        # The backstop for the single-writer rule (§2.3). If a second writer ever
        # appears, this fails loudly instead of corrupting the replay silently.
        UniqueConstraint("mission_id", "seq", name="uq_mission_events_seq"),
        Index("ix_mission_events_resume", "mission_id", "seq"),
    )


class ProviderProfile(Base):
    """An endpoint plus the capabilities we actually observed there — not the
    ones its docs claim (§3.1). Never holds a key: that lives in the keychain."""

    __tablename__ = "provider_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    base_url: Mapped[str | None] = mapped_column(String, nullable=True)
    model: Mapped[str] = mapped_column(String, nullable=False)
    capabilities: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "kind IN ('openai_compatible', 'anthropic')", name="ck_provider_kind"
        ),
    )


class Agent(Base):
    """A character in the roster.

    No `exp` and no `level`: gamification was rolled back (§1.1, decision row
    28). They were scores we invented, and a card that shows an invented number
    is a card that lies. `total_missions` stays because it counts missions that
    actually finished.

    `sampling` is JSON rather than a `temperature` column because some models
    reject sampling parameters outright — Sonnet 5 answers a `temperature` with
    a 400 while Haiku 4.5 accepts it. The provider decides what to send from the
    capabilities it observed (§3.1).
    """

    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    role: Mapped[str] = mapped_column(String, nullable=False, default="")
    backstory: Mapped[str] = mapped_column(Text, nullable=False, default="")
    personality_traits: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")

    provider_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("provider_profiles.id", ondelete="SET NULL"), nullable=True
    )
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    sampling: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    tools: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)

    #: When a tool call stops to ask the user (§16.4). `ask_dangerous` by
    #: default: `bash` and `web_fetch` are the two that can do something the
    #: user cannot undo, and the gate in front of them is the only one there is
    #: — there is no sandbox behind it (§2.7).
    autonomy: Mapped[str] = mapped_column(
        String, nullable=False, default="ask_dangerous", server_default="ask_dangerous"
    )
    avatar_config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    #: Counted from missions that actually finished. A fact, not a score.
    total_missions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    #: Set on import so a re-import can recognise what it already brought in
    #: rather than silently making a third copy (§5.3).
    source_id: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: Soft delete only. A hard delete would strand every team and every
    #: finished mission that refers to this agent (§5.2).
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (Index("ix_agents_archived_at", "archived_at"),)


class Team(Base):
    """A saved team.

    Members are references, not copies: editing an agent changes every team it
    is on, and there is no versioning (§5). `duplicate` on the agent is the
    escape hatch for anyone who wants a configuration frozen, and
    `missions.roster_snapshot` is what keeps a finished run honest.
    """

    __tablename__ = "teams"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    emblem_config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    #: A string enum validated at the app layer; there is no layouts table (§13).
    scene_layout_id: Mapped[str] = mapped_column(String, nullable=False)
    default_budget: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    #: Set on import, so a re-import can recognise what it already brought in
    #: instead of silently making a third copy (§5.3).
    source_id: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: Soft delete, like agents: finished missions still point here (§5.2).
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class TeamMember(Base):
    """One agent in one seat of one team.

    Two constraints carry real weight. `UNIQUE(team_id, seat_index)` stops two
    characters being drawn at the same desk in M5. The partial unique index on
    the leader row enforces *at most* one leader — "at least one" cannot be
    expressed in SQL and lives in the validator instead (§5.2).
    """

    __tablename__ = "team_members"

    team_id: Mapped[str] = mapped_column(
        String, ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True
    )
    agent_id: Mapped[str] = mapped_column(
        String, ForeignKey("agents.id", ondelete="RESTRICT"), primary_key=True
    )
    seat_index: Mapped[int] = mapped_column(Integer, nullable=False)
    role_in_team: Mapped[str] = mapped_column(String, nullable=False, default="member")
    #: Per-team model / tool_subset / prompt_suffix. Resolved into
    #: `missions.roster_snapshot` at launch so the timeline reports the config
    #: that actually ran, not the agent's defaults (§5.1).
    overrides: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    __table_args__ = (
        UniqueConstraint("team_id", "seat_index", name="uq_team_members_seat"),
        CheckConstraint(
            "role_in_team IN ('leader', 'member')", name="ck_team_members_role"
        ),
        CheckConstraint("seat_index >= 0", name="ck_team_members_seat_non_negative"),
    )


class Artifact(Base):
    """Something a mission produced and the user can open (§5).

    `path` is relative to the artifact root and never absolute. A viewer that
    could be handed an absolute path would turn "see what the agent made" into
    "read any file on this machine", on a process that holds the keychain.
    """

    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    mission_id: Mapped[str] = mapped_column(
        String, ForeignKey("missions.id", ondelete="RESTRICT"), nullable=False
    )
    agent_id: Mapped[str | None] = mapped_column(String, nullable=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    path: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint("kind IN ('code', 'doc', 'image')", name="ck_artifacts_kind"),
        UniqueConstraint("mission_id", "path", name="uq_artifacts_path"),
        Index("ix_artifacts_mission", "mission_id"),
    )


class RecentWorkspace(Base):
    """Folders the user has pointed a mission at before (§16.2).

    A convenience, never a permission: picking one from the list runs the same
    validation as a path typed by hand. Otherwise "it passed once" would become
    a way around the checks — and a folder can stop being safe to write to
    between two launches.
    """

    __tablename__ = "recent_workspaces"

    #: The resolved path is the identity, so choosing the same folder twice
    #: moves it up the list instead of growing it.
    path: Mapped[str] = mapped_column(Text, primary_key=True)
    last_used_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
