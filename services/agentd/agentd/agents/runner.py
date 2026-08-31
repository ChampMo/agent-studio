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
from ..db.models import Mission, ProviderProfile
from ..db.session import Database
from ..providers import registry
from ..providers.base import ChatRequest, Message, ProviderError
from .runtime import is_ephemeral, run_agent_turn

#: The stand-in agent for a chat. M2 brings the real `agents` table; until then
#: this keeps the §5.1 invariant true from day one — everything that runs reads
#: the mission's roster snapshot, never a live row.
CHAT_AGENT_ID = "chat-agent"


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
        self._tasks[mission_id] = task
        task.add_done_callback(lambda _t: self._tasks.pop(mission_id, None))
        return mission_id

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
