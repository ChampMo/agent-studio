"""Mission lifecycle: the caller the runtime was designed for (§4.1).

This is the layer that owns everything the runtime deliberately does not know
about — the mission row, the bus, the budget's consequences, and cancellation.
In M4 a LangGraph node takes this role for a whole team; the runtime underneath
does not change.

A chat is a degenerate mission (§15 row 4). That single decision is what gives
plain chat a timeline, a replay, a budget guard and a stop button without a
second code path for any of them.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from ..core.budget import BudgetExceeded, BudgetLimits, BudgetTracker, resolve_limits
from ..core.events import EventBus
from ..db.models import Agent, Mission, ProviderProfile, Team, TeamMember
from ..db.session import Database
from ..orchestrator.graph import run_team_mission
from ..orchestrator.planner import PlanningFailed
from ..providers import registry
from ..providers.base import (
    Capabilities,
    ChatRequest,
    LLMProvider,
    Message,
    ProviderError,
)
from ..teams import snapshot as snapshot_mod
from ..teams.snapshot import RosterSnapshot, SnapshotMember
from ..teams.validator import blocking, validate
from .runtime import is_ephemeral, run_agent_turn

#: The stand-in agent for a chat. M2 brings the real `agents` table; until then
#: this keeps the §5.1 invariant true from day one — everything that runs reads
#: the mission's roster snapshot, never a live row.
CHAT_AGENT_ID = "chat-agent"


class MissionRejected(ValueError):
    """The team cannot run. Carries every blocking finding, because one reason at
    a time turns fixing a team into a guessing game (§5.2)."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


class MissionRunner:
    def __init__(self, db: Database, bus: EventBus) -> None:
        self._db = db
        self._bus = bus
        self._tasks: dict[str, asyncio.Task] = {}
        #: Finalisation runs in its own task so that cancelling a mission cannot
        #: cancel the work that records the cancellation. See `_run`.
        self._finishers: dict[str, asyncio.Task] = {}

    # ---- lifecycle ----------------------------------------------------

    async def start_chat(
        self,
        *,
        profile: ProviderProfile,
        content: str,
        budget: dict[str, Any] | None = None,
        system: str | None = None,
    ) -> str:
        """Create the mission, then run the turn in the background.

        Returns as soon as the row exists. The reply arrives over the WebSocket,
        because the event stream is the only way anything leaves the backend
        (§2.1) — an HTTP response carrying the answer would be a second channel
        that the timeline and the scene know nothing about.
        """
        limits = resolve_limits(mission=budget)
        mission_id = f"chat-{uuid.uuid4()}"

        async with self._db.session() as s:
            s.add(
                Mission(
                    id=mission_id,
                    kind="chat",
                    team_id=None,
                    goal=content[:200],
                    status="running",
                    budget=limits.as_dict(),
                    roster_snapshot=[_snapshot_entry(profile, system)],
                    started_at=datetime.now(UTC),
                )
            )
            await s.commit()

        await self._bus.publish(
            mission_id,
            {
                "type": "mission.started",
                "payload": {"kind": "chat", "goal": content[:200]},
            },
        )
        await self._bus.publish(
            mission_id, {"type": "user.message", "payload": {"content": content}}
        )

        task = asyncio.create_task(
            self._run(mission_id, profile, content, system, limits),
            name=f"mission:{mission_id}",
        )
        self._track(mission_id, task)
        return mission_id

    async def start_mission(
        self,
        *,
        team_id: str,
        goal: str,
        budget: dict[str, Any] | None = None,
    ) -> str:
        """Launch a team (§7).

        Two things happen before the first event, in this order and no other:
        the validator blocks a team that cannot run, and the roster is frozen
        into the mission row. After that the tables read here stop mattering —
        an edit to an agent cannot reach a mission already under way (§5.1).
        """
        async with self._db.session() as s:
            team = (
                await s.execute(select(Team).where(Team.id == team_id))
            ).scalar_one_or_none()
            if team is None:
                raise MissionRejected([f"no team {team_id!r}"])
            members = list(
                (
                    await s.execute(
                        select(TeamMember)
                        .where(TeamMember.team_id == team_id)
                        .order_by(TeamMember.seat_index)
                    )
                )
                .scalars()
                .all()
            )
            agents = {
                a.id: a
                for a in (
                    await s.execute(
                        select(Agent).where(Agent.id.in_([m.agent_id for m in members]))
                    )
                )
                .scalars()
                .all()
            }

        # The run gate, and it is the same finding list the builder showed
        # (§5.2). There is no second set of preconditions here.
        findings = validate(
            layout_id=team.scene_layout_id, members=members, agents=agents
        )
        if errors := blocking(findings):
            raise MissionRejected([f.message for f in errors])

        roster = snapshot_mod.resolve(team=team, members=members, agents=agents)
        limits = resolve_limits(mission=budget, team_default=team.default_budget)
        mission_id = f"mission-{uuid.uuid4()}"

        async with self._db.session() as s:
            s.add(
                Mission(
                    id=mission_id,
                    kind="mission",
                    team_id=team_id,
                    goal=goal,
                    status="running",
                    budget=limits.as_dict(),
                    roster_snapshot=roster.to_json(),
                    started_at=datetime.now(UTC),
                )
            )
            await s.commit()

        await self._bus.publish(
            mission_id,
            {
                "type": "mission.started",
                "payload": {"kind": "mission", "teamId": team_id, "goal": goal},
            },
        )
        await self._bus.publish(
            mission_id, {"type": "user.message", "payload": {"content": goal}}
        )

        task = asyncio.create_task(
            self._run_team(mission_id, roster, goal, limits),
            name=f"mission:{mission_id}",
        )
        self._track(mission_id, task)
        return mission_id

    async def _run_team(
        self,
        mission_id: str,
        roster: RosterSnapshot,
        goal: str,
        limits: BudgetLimits,
    ) -> None:
        budget = BudgetTracker(limits)
        opened: dict[str, LLMProvider] = {}
        reason, summary = "completed", ""

        # Provider profiles are looked up from the snapshot's provider_id, never
        # from the agent row: past the launch boundary the snapshot is the only
        # source (§5.1).
        profiles: dict[str, ProviderProfile] = {}
        async with self._db.session() as s:
            ids = {m.provider_id for m in roster.members if m.provider_id}
            if ids:
                rows = await s.execute(
                    select(ProviderProfile).where(ProviderProfile.id.in_(ids))
                )
                profiles = {p.id: p for p in rows.scalars().all()}

        def provider_for(member: SnapshotMember) -> tuple[LLMProvider, Capabilities]:
            profile = profiles.get(member.provider_id or "")
            if profile is None:
                raise ProviderError(
                    "no_provider", f"{member.name} has no usable provider profile"
                )
            if member.agent_id not in opened:
                opened[member.agent_id] = registry.build_from_profile(profile)
            return opened[member.agent_id], registry.capabilities_for(profile)

        try:
            async for item in run_team_mission(
                mission_id=mission_id,
                snapshot=roster,
                goal=goal,
                budget=budget,
                provider_for=provider_for,
            ):
                # The same routing split a chat uses (§7.1), in the same place.
                if is_ephemeral(item):
                    self._bus.broadcast_ephemeral(item)
                else:
                    await self._bus.publish(mission_id, item)
                    if item["type"] == "agent.message":
                        summary = item["payload"]["content"][:2000]

        except asyncio.CancelledError:
            reason, summary = "cancelled", "stopped by the user"
            raise
        except BudgetExceeded as exc:
            reason = "budget_exceeded"
            summary = f"stopped at the {exc.kind} limit ({exc.used}/{exc.limit})"
        except PlanningFailed as exc:
            reason, summary = "failed", f"the leader could not produce a plan: {exc}"
            await self._publish_error(mission_id, "planning_failed", summary, False)
        except ProviderError as exc:
            reason, summary = "failed", exc.message
            await self._publish_error(mission_id, exc.code, exc.message, exc.recoverable)
        except Exception as exc:  # noqa: BLE001 - a crash must still be recorded
            reason, summary = "crashed", f"{type(exc).__name__}: {exc}"
            await self._publish_error(mission_id, "internal_error", summary, False)
        finally:
            # Scheduled, never awaited here: this block also runs while the task
            # is being cancelled, and an await would be cancelled with it.
            self._finishers[mission_id] = asyncio.create_task(
                self._finalise_team(
                    mission_id, list(opened.values()), roster, reason, summary
                ),
                name=f"finalise:{mission_id}",
            )

    async def _publish_error(
        self, mission_id: str, code: str, message: str, recoverable: bool
    ) -> None:
        await self._bus.publish(
            mission_id,
            {
                "type": "error",
                "payload": {
                    "code": code,
                    "message": message,
                    "recoverable": recoverable,
                },
            },
        )

    async def _finalise_team(
        self,
        mission_id: str,
        providers: list[LLMProvider],
        roster: RosterSnapshot,
        reason: str,
        summary: str,
    ) -> None:
        for provider in providers:
            try:
                await provider.aclose()
            except Exception:  # noqa: BLE001 - a failed close must not lose the event
                pass
        if reason == "completed":
            await self._credit_missions(roster)
        await self._finish(mission_id, reason, summary)

    async def _credit_missions(self, roster: RosterSnapshot) -> None:
        """`total_missions` counts runs that actually finished (§1.1).

        Only on `completed`. A cancelled or crashed run is not a mission the
        agent completed, and a count that included them would stop being true —
        which is the whole reason the number is allowed on the card at all.
        """
        async with self._db.session() as s:
            rows = await s.execute(
                select(Agent).where(Agent.id.in_([m.agent_id for m in roster.members]))
            )
            for agent in rows.scalars().all():
                agent.total_missions += 1
            await s.commit()

    def _track(self, mission_id: str, task: asyncio.Task) -> None:
        """Remember the task, and guarantee the mission is recorded either way.

        A task cancelled before its body ever ran executes no `finally`, so it
        schedules no finaliser: the row would sit at `running` forever with no
        `mission.ended`, which is the one thing every mission is promised. The
        callback covers exactly that window.
        """
        self._tasks[mission_id] = task

        def _done(_t: asyncio.Task) -> None:
            self._tasks.pop(mission_id, None)
            if _t.cancelled() and mission_id not in self._finishers:
                self._finishers[mission_id] = asyncio.create_task(
                    self._finish(mission_id, "cancelled", "stopped by the user"),
                    name=f"finalise:{mission_id}",
                )

        task.add_done_callback(_done)

    async def cancel(self, mission_id: str) -> bool:
        """Stop a running mission. Cancelling the task closes the runtime
        generator, which closes the provider stream — no flag to poll, and no
        way for a code path to forget to check one."""
        task = self._tasks.get(mission_id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    def is_running(self, mission_id: str) -> bool:
        task = self._tasks.get(mission_id)
        return task is not None and not task.done()

    async def wait(self, mission_id: str) -> None:
        """Tests only: await the turn AND its finalisation.

        Both, because the mission.ended event is written by the finaliser;
        awaiting only the turn would race a cancelled mission's own record.
        """
        task = self._tasks.get(mission_id)
        if task:
            await asyncio.gather(task, return_exceptions=True)
        finisher = self._finishers.get(mission_id)
        if finisher:
            await asyncio.gather(finisher, return_exceptions=True)

    # ---- the run ------------------------------------------------------

    async def _run(
        self,
        mission_id: str,
        profile: ProviderProfile,
        content: str,
        system: str | None,
        limits: BudgetLimits,
    ) -> None:
        budget = BudgetTracker(limits)
        provider = None
        reason, summary = "completed", ""

        try:
            provider = registry.build_from_profile(profile)
            caps = registry.capabilities_for(profile)
            request = ChatRequest(
                model=profile.model,
                messages=[Message("user", content)],
                max_tokens=limits.max_tokens,
                system=system,
            )

            turn = run_agent_turn(
                provider=provider,
                caps=caps,
                request=request,
                mission_id=mission_id,
                agent_id=CHAT_AGENT_ID,
                budget=budget,
            )
            async for item in turn:
                # The routing split from §7.1, in the one place that performs it.
                if is_ephemeral(item):
                    self._bus.broadcast_ephemeral(item)
                else:
                    await self._bus.publish(mission_id, item)
                    if item["type"] == "agent.message":
                        summary = item["payload"]["content"][:500]

        except asyncio.CancelledError:
            # Do not await anything here. This task is being torn down, and any
            # further await is liable to be cancelled mid-flight — which is how
            # a stopped mission ended up with no mission.ended event and a row
            # stuck at status "running". The finally block schedules the
            # recording instead of performing it.
            reason, summary = "cancelled", "stopped by the user"
            raise
        except BudgetExceeded as exc:
            reason = "budget_exceeded"
            summary = f"stopped at the {exc.kind} limit ({exc.used}/{exc.limit})"
        except ProviderError as exc:
            reason, summary = "failed", exc.message
            await self._bus.publish(
                mission_id,
                {
                    "type": "error",
                    "payload": {
                        "agentId": CHAT_AGENT_ID,
                        "code": exc.code,
                        "message": exc.message,
                        "recoverable": exc.recoverable,
                    },
                },
            )
        except Exception as exc:  # noqa: BLE001 - a crash must still be recorded
            reason, summary = "crashed", f"{type(exc).__name__}: {exc}"
            await self._bus.publish(
                mission_id,
                {
                    "type": "error",
                    "payload": {
                        "agentId": CHAT_AGENT_ID,
                        "code": "internal_error",
                        "message": summary,
                        "recoverable": False,
                    },
                },
            )
        finally:
            # Schedule, never await: this block also runs while the task is
            # being cancelled, and an await here would be cancelled with it.
            self._finishers[mission_id] = asyncio.create_task(
                self._finalise(mission_id, provider, reason, summary),
                name=f"finalise:{mission_id}",
            )

    async def _finalise(
        self, mission_id: str, provider, reason: str, summary: str
    ) -> None:
        """Close the provider and record the outcome, in a task of its own.

        Separate from `_run` so that cancelling a mission cannot cancel the work
        that records the cancellation. Every mission ends with exactly one
        `mission.ended`, including the ones the user stopped.
        """
        if provider is not None:
            try:
                await provider.aclose()
            except Exception:  # noqa: BLE001 - a failed close must not lose the event
                pass
        await self._finish(mission_id, reason, summary)

    async def _finish(self, mission_id: str, reason: str, summary: str) -> None:
        """Every mission ends with exactly one `mission.ended`, carrying why.

        `ok: true/false` was not enough: completed, budget_exceeded, cancelled
        and crashed have to look different in the timeline and in the scene
        (§15 row 8).
        """
        await self._bus.publish(
            mission_id,
            {"type": "mission.ended", "payload": {"reason": reason, "summary": summary}},
        )
        async with self._db.session() as s:
            mission = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if mission is not None:
                mission.status = "ended"
                mission.ended_at = datetime.now(UTC)
                mission.end_reason = reason
                mission.result_summary = summary
                await s.commit()


def _snapshot_entry(profile: ProviderProfile, system: str | None) -> dict[str, Any]:
    """The effective config, frozen at start. Editing the provider profile
    afterwards must not change how this mission replays (§5.1)."""
    return {
        "agent_id": CHAT_AGENT_ID,
        "name": "Assistant",
        "seat_index": 0,
        "role_in_team": "leader",
        "provider_id": profile.id,
        "model": profile.model,
        "system_prompt": system,
        "tools": [],
        "avatar_config": None,
    }
