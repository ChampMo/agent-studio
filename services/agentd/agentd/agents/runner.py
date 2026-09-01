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

from sqlalchemy import or_, select

from ..core.budget import BudgetExceeded, BudgetLimits, BudgetTracker, resolve_limits
from ..core.events import EventBus
from ..db.models import Agent, Mission, ProviderProfile, Team, TeamMember
from ..db.session import Database
from ..artifacts.store import ArtifactStore
from ..orchestrator.graph import Paused, run_team_mission
from ..orchestrator.hitl import PlanRejected
from ..orchestrator.planner import PlanningFailed
from ..core import secrets
from ..tools import registry as tool_registry
from ..tools.search import DEFAULT_ENDPOINT as DEFAULT_SEARCH_ENDPOINT
from ..tools.search import SearchEndpoint
from ..tools.shell import find_shell
from ..tools.team import Mailbox
from ..tools.base import ToolContext
from ..tools.execution import ToolBox
from ..tools.workspace import WorkspaceRejected, WorkspaceStore
from ..tools.workspace import check as workspace_check
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


class RequestNotFound(LookupError):
    """No mission is waiting on that request.

    Distinct from a wrong answer: it means the question was already answered, or
    the mission ended, and the caller needs to know which.
    """


class MissionRejected(ValueError):
    """The team cannot run. Carries every blocking finding, because one reason at
    a time turns fixing a team into a guessing game (§5.2)."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


class MissionRunner:
    def __init__(
        self, db: Database, bus: EventBus, checkpointer: Any | None = None
    ) -> None:
        self._db = db
        self._bus = bus
        #: Where a paused graph is written so a different process can resume it.
        #: Optional: without one the app still runs, approvals simply cannot
        #: survive a restart, and tests inject an in-memory saver.
        self._checkpointer = checkpointer
        self._tasks: dict[str, asyncio.Task] = {}
        #: Finalisation runs in its own task so that cancelling a mission cannot
        #: cancel the work that records the cancellation. See `_run`.
        self._finishers: dict[str, asyncio.Task] = {}
        self._artifacts = ArtifactStore(db)
        #: What each paused mission needs in order to be resumed. Rebuilt from
        #: the database on restart, because the process that paused is gone.
        self._paused: dict[str, dict[str, Any]] = {}
        #: Tool approvals a *live* turn is waiting on: request id -> (mission,
        #: future). Unlike a plan approval these do not survive the process
        #: (§16.4). There is no checkpoint in the middle of a turn, so if this
        #: process dies the mission is crashed and the tool never ran - which
        #: is the safe direction to fail in.
        self._awaiting: dict[str, tuple[str, asyncio.Future[str]]] = {}
        self._marks: set[asyncio.Task] = set()

    async def reap_orphans(self) -> int:
        """Close out missions left `running` by a process that is gone.

        A crash, a kill, or the dev launcher restarting the backend takes the
        task with it, and a dead process cannot write its own terminal event.
        The row would then claim a mission is still running when nothing is
        driving it -- and every mission is promised exactly one `mission.ended`.

        Run once at startup, before anything can read the table.
        """
        async with self._db.session() as s:
            # Only `running`. A mission with status `waiting` has no task by
            # design - it is paused on a person - and closing those would
            # destroy exactly the missions M6 promises survive a restart.
            orphans = list(
                (await s.execute(select(Mission).where(Mission.status == "running")))
                .scalars()
                .all()
            )

        for mission in orphans:
            await self._finish(
                mission.id,
                "crashed",
                "the backend stopped while this mission was running",
            )
        return len(orphans)

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
        require_approval: bool = False,
        workspace_root: str | None = None,
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

        # The workspace is re-checked here even though the picker checked it:
        # the path came from a window, and this is the process that will act on
        # it (§16.2). A folder can also stop being a directory between the two.
        resolved_workspace: str | None = None
        if workspace_root:
            try:
                resolved_workspace = workspace_check(workspace_root).path
            except WorkspaceRejected as exc:
                raise MissionRejected([f"workspace: {exc.reason}"]) from exc

        # A team that can touch files without a folder chosen has no boundary
        # at all, so this is a launch gate rather than a warning (§16.2).
        if resolved_workspace is None:
            wanted = sorted(
                {
                    tool
                    for agent in agents.values()
                    for tool in tool_registry.needs_workspace(list(agent.tools))
                }
            )
            if wanted:
                raise MissionRejected(
                    [
                        "choose a workspace folder before running this team: "
                        + ", ".join(wanted)
                        + " can only run inside one"
                    ]
                )

        roster = snapshot_mod.resolve(
            team=team, members=members, agents=agents, workspace_root=resolved_workspace
        )
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
                    workspace_root=resolved_workspace,
                    started_at=datetime.now(UTC),
                )
            )
            await s.commit()

        if resolved_workspace:
            # Remembered only once a mission actually used it, so the list is
            # of folders that were worked in rather than folders that were
            # browsed to (§16.2).
            await WorkspaceStore(self._db).remember(resolved_workspace)

        started: dict[str, Any] = {"kind": "mission", "teamId": team_id, "goal": goal}
        if resolved_workspace:
            # On the log, so a replay can say where the work happened rather
            # than where this build would put it today (§5.1).
            started["workspaceRoot"] = resolved_workspace
        await self._bus.publish(
            mission_id, {"type": "mission.started", "payload": started}
        )
        await self._bus.publish(
            mission_id, {"type": "user.message", "payload": {"content": goal}}
        )

        task = asyncio.create_task(
            self._run_team(
                mission_id, roster, goal, limits, require_approval=require_approval
            ),
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
        *,
        require_approval: bool = False,
        resume: str | None = None,
    ) -> None:
        budget = BudgetTracker(limits)
        opened: dict[str, LLMProvider] = {}
        reason, summary = "completed", ""
        parked = False
        # The gate is the only thing that pauses a mission, so a resume implies
        # it was there. Rebuilding without it made `approve_node` return before
        # it read the answer: the graph carried on either way, and a rejected
        # plan ran to completion.
        require_approval = require_approval or resume is not None

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

        # Looked up once for the mission: the search endpoint and its key, if
        # one is configured. A tool never reads the keychain itself (§9.2), and
        # `web_search` is simply not offered when there is nothing behind it
        # (§15 row 32).
        search_endpoint: SearchEndpoint | None = None
        for profile in profiles.values():
            if profile.kind == "search" and (key := secrets.get_key(profile.id)):
                search_endpoint = SearchEndpoint(
                    api_key=key, base_url=profile.base_url or DEFAULT_SEARCH_ENDPOINT
                )
                break
        if search_endpoint is None:
            async with self._db.session() as s:
                rows = await s.execute(
                    select(ProviderProfile).where(ProviderProfile.kind == "search")
                )
                for profile in rows.scalars().all():
                    if key := secrets.get_key(profile.id):
                        search_endpoint = SearchEndpoint(
                            api_key=key,
                            base_url=profile.base_url or DEFAULT_SEARCH_ENDPOINT,
                        )
                        break

        # One mailbox for the mission. Not persisted: what was said is on the
        # event log, and a second copy would be a second thing to keep true.
        mailbox = Mailbox({m.agent_id: m.name for m in roster.members})

        async def ask(agent_id: str, question: str) -> str | None:
            """`ask_user`, using M6's request end to end (§16.7).

            The runner publishes and the runner waits, because the runner is
            what owns the bus and the routing. Same event, same endpoint and
            same modal as an approval - only `kind` differs.
            """
            request_id = f"req-{uuid.uuid4()}"
            waiting = self.open(mission_id, request_id)
            await self._bus.publish(
                mission_id,
                {
                    "type": "agent.request",
                    "payload": {
                        "agentId": agent_id,
                        "requestId": request_id,
                        "kind": "question",
                        "question": question,
                    },
                },
            )
            await self._bus.publish(
                mission_id,
                {"type": "agent.status", "payload": {"agentId": agent_id, "status": "waiting"}},
            )
            try:
                return await waiting
            except asyncio.CancelledError:
                # The mission ended while the question was on screen. Reported
                # to the tool as unanswered rather than swallowed.
                return None

        met_requirements = {"workspace"} if roster.workspace_root else set()
        if search_endpoint is not None:
            met_requirements.add("search_provider")
        if find_shell() is not None:
            met_requirements.add("shell")

        def tools_for(member: SnapshotMember) -> ToolBox | None:
            """The tools this member may use, scoped to this mission.

            Everything here comes from the frozen snapshot: which tools, how
            much the agent is trusted, and which folder it may touch (§5.1).
            Nothing is read from the `agents` table mid-flight, so an edit made
            while a mission runs cannot widen what it is allowed to do.
            """
            specs = [
                spec
                for tool_id in member.tools
                if (spec := tool_registry.get(tool_id)) is not None
                # A tool whose requirement is not met is left out rather than
                # offered and failing: a model that calls it learns nothing and
                # has already paid for the round.
                and set(spec.requires) <= met_requirements
            ]
            if not specs:
                return None
            return ToolBox(
                specs=specs,
                context=ToolContext(
                    mission_id=mission_id,
                    agent_id=member.agent_id,
                    workspace_root=roster.workspace_root,
                    extras={
                        "db": self._db,
                        "mailbox": mailbox,
                        "ask": ask,
                        **({"search": search_endpoint} if search_endpoint else {}),
                    },
                ),
                autonomy=member.autonomy,
                gate=self,
            )

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
                tools_for=tools_for,
                checkpointer=self._checkpointer,
                require_approval=require_approval,
                resume=resume,
            ):
                # The same routing split a chat uses (§7.1), in the same place.
                if is_ephemeral(item):
                    self._bus.broadcast_ephemeral(item)
                else:
                    await self._bus.publish(mission_id, item)
                    if item["type"] == "agent.message":
                        summary = item["payload"]["content"][:2000]

        except Paused as paused:
            # Not an ending. The mission stops here, keeps its row, and waits -
            # possibly past the life of this process (§12 M6).
            #
            # `parked` rather than an early `return`: `finally` runs through a
            # return, so returning here still scheduled the finaliser and the
            # mission was recorded as `completed` seconds after asking its
            # question. A pause has to suppress the ending explicitly.
            parked = True
            await self._park(mission_id, roster, goal, limits, paused, opened)
        except asyncio.CancelledError:
            reason, summary = "cancelled", "stopped by the user"
            raise
        except PlanRejected as exc:
            # A decision, not a failure. Recorded as such so the timeline does
            # not describe the user changing their mind as something breaking.
            reason, summary = "cancelled", f"the plan was rejected: {exc.note}"
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
            # A parked mission has not ended - it is waiting on a person, and
            # finalising it here would close it seconds after it asked its
            # question, with `completed` still sitting in `reason`.
            if parked:
                return
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
        self._abandon_waiting(mission_id)
        for provider in providers:
            try:
                await provider.aclose()
            except Exception:  # noqa: BLE001 - a failed close must not lose the event
                pass
        if reason == "completed":
            await self._credit_missions(roster)
            await self._save_answer(mission_id, roster, summary)
        await self._finish(mission_id, reason, summary)

    async def _save_answer(
        self, mission_id: str, roster: RosterSnapshot, summary: str
    ) -> None:
        """Keep the mission's answer as a file the user can open (§12 M6).

        A run that produced nothing gets no artifact: an empty document in the
        viewer would suggest work happened that did not.
        """
        if not summary.strip():
            return
        leader = roster.leader
        try:
            artifact = await self._artifacts.write_text(
                mission_id=mission_id,
                agent_id=leader.agent_id if leader else None,
                title="Final answer",
                text=summary,
            )
        except Exception as exc:  # noqa: BLE001 - the mission still completed
            await self._publish_error(
                mission_id, "artifact_write_failed", str(exc), True
            )
            return

        await self._bus.publish(
            mission_id,
            {
                "type": "artifact.created",
                "payload": {
                    "agentId": artifact.agent_id or "",
                    "artifactId": artifact.id,
                    "path": artifact.path,
                    "kind": artifact.kind,
                },
            },
        )

    # ---- human in the loop --------------------------------------------

    async def _park(
        self,
        mission_id: str,
        roster: RosterSnapshot,
        goal: str,
        limits: BudgetLimits,
        paused: Paused,
        opened: dict[str, LLMProvider],
    ) -> None:
        """Record the pause and stand down.

        The providers are closed: waiting for a person can take days, and a held
        HTTP connection is not how you wait for one. Resuming builds fresh ones.
        """
        for provider in opened.values():
            try:
                await provider.aclose()
            except Exception:  # noqa: BLE001
                pass

        self._paused[mission_id] = {
            "roster": roster,
            "goal": goal,
            "limits": limits,
            "request_id": paused.ask.request_id,
        }

        async with self._db.session() as s:
            mission = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if mission is not None:
                mission.status = "waiting"
                mission.pending_request = paused.ask.request_id
                await s.commit()

    # ---- tool approvals (§16.4) ----------------------------------------

    def open(self, mission_id: str, request_id: str) -> asyncio.Future[str]:
        """Start waiting for an answer, before the question is published.

        Synchronous on purpose. The runtime registers here and *then* yields the
        `agent.request`, so there is no window in which an answer arrives for a
        question nobody is waiting on - the same ordering rule as subscribing to
        the bus before accepting a WebSocket.
        """
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._awaiting[request_id] = (mission_id, future)

        # The row is updated in the background: `pending_request` is what a
        # client that reconnects reads, and the answer path does not depend on
        # it having landed.
        task = asyncio.create_task(self._mark_pending(mission_id, request_id))
        self._marks.add(task)
        task.add_done_callback(self._marks.discard)
        return future

    async def _mark_pending(self, mission_id: str, request_id: str) -> None:
        async with self._db.session() as s:
            mission = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if mission is not None and mission.status == "running":
                mission.pending_request = request_id
                await s.commit()

    async def _clear_pending(self, mission_id: str) -> None:
        async with self._db.session() as s:
            mission = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if mission is not None and mission.pending_request:
                mission.pending_request = None
                await s.commit()

    def _abandon_waiting(self, mission_id: str) -> None:
        """Nobody is coming back to these: the mission is over."""
        for request_id, (owner, future) in list(self._awaiting.items()):
            if owner != mission_id:
                continue
            self._awaiting.pop(request_id, None)
            if not future.done():
                future.cancel()

    async def resolve_request(
        self, request_id: str, answer: str, *, resolved_by: str = "user"
    ) -> str:
        """Answer a waiting mission and let it carry on.

        Two shapes of pause end here, and they are answered the same way from
        the outside - same event, same endpoint, same modal (§15 row 30). A tool
        approval is a live turn holding a future; a plan approval is a graph
        checkpoint that may have been written by a process that no longer
        exists. Only the second can be resumed after a restart.
        """
        if (waiting := self._awaiting.pop(request_id, None)) is not None:
            mission_id, future = waiting
            await self._bus.publish(
                mission_id,
                {
                    "type": "agent.request.resolved",
                    "payload": {
                        "requestId": request_id,
                        "answer": answer,
                        "resolvedBy": resolved_by,
                    },
                },
            )
            await self._clear_pending(mission_id)
            if not future.done():
                future.set_result(answer)
            return mission_id

        async with self._db.session() as s:
            mission = (
                await s.execute(
                    select(Mission).where(Mission.pending_request == request_id)
                )
            ).scalar_one_or_none()
        if mission is None:
            raise RequestNotFound(request_id)

        # Published before the resume: a replay must show the question, then the
        # answer, then what followed from it (§6.2).
        await self._bus.publish(
            mission.id,
            {
                "type": "agent.request.resolved",
                "payload": {
                    "requestId": request_id,
                    "answer": answer,
                    "resolvedBy": resolved_by,
                },
            },
        )

        roster = RosterSnapshot.from_json(mission.roster_snapshot)
        limits = resolve_limits(mission=mission.budget)
        async with self._db.session() as s:
            row = (
                await s.execute(select(Mission).where(Mission.id == mission.id))
            ).scalar_one()
            row.status = "running"
            row.pending_request = None
            await s.commit()
        self._paused.pop(mission.id, None)

        task = asyncio.create_task(
            self._run_team(
                mission.id, roster, mission.goal, limits, resume=answer
            ),
            name=f"mission:{mission.id}",
        )
        self._track(mission.id, task)
        return mission.id

    async def pending_requests(self) -> list[dict[str, Any]]:
        """What is waiting for the user, across every mission.

        A restarted frontend has to find these: the question was published as an
        event long ago, and a client that reconnects to nothing would leave the
        mission stuck for ever with nobody aware of it.
        """
        async with self._db.session() as s:
            # `waiting` covers a plan approval, which parks the mission. A tool
            # approval leaves it `running` — the process is alive and a turn is
            # holding a future — so the column has to be checked too, or a
            # client that reconnects mid-question sees nothing (§16.4).
            rows = await s.execute(
                select(Mission).where(
                    or_(
                        Mission.status == "waiting",
                        Mission.pending_request.is_not(None),
                    )
                )
            )
            missions = list(rows.scalars().all())

        out: list[dict[str, Any]] = []
        for mission in missions:
            question = await self._last_request(mission.id, mission.pending_request)
            out.append(
                {
                    "missionId": mission.id,
                    "requestId": mission.pending_request,
                    "goal": mission.goal,
                    "askedAt": mission.started_at.isoformat(),
                    **(question or {}),
                }
            )
        return out

    async def _last_request(
        self, mission_id: str, request_id: str | None
    ) -> dict[str, Any] | None:
        """The question itself, read back off the append-only log.

        The log is the record; `pending_request` is only the index into it.
        """
        if not request_id:
            return None
        for event in await self._bus.history(mission_id, 0, 10**9):
            draft = event["draft"]
            if (
                draft["type"] == "agent.request"
                and draft["payload"].get("requestId") == request_id
            ):
                return {
                    "question": draft["payload"].get("question", ""),
                    "kind": draft["payload"].get("kind", "question"),
                    "options": draft["payload"].get("options"),
                    "agentId": draft["payload"].get("agentId"),
                }
        return None

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
                # Cleared with the ending. A question belonging to a mission
                # that is over is a modal nobody can usefully answer: the
                # backend would refuse the answer with a 409, and the run it
                # belonged to is already on the record as crashed or cancelled.
                mission.pending_request = None
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
