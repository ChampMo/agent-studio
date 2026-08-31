"""SQLAlchemy models.

Only the tables M1 needs exist here. `agents`, `teams`, `team_members` and
`artifacts` arrive with M2/M3/M6 — but `missions` already carries the columns
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
