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

from sqlalchemy import or_, select, update

from ..core.prefs import get_app_budget, get_autonomy
from ..core.budget import BudgetExceeded, BudgetLimits, BudgetTracker, resolve_limits
from ..core.events import EventBus
from ..db.models import MissionEvent, Agent, Mission, ProviderProfile, Team, TeamMember
from ..db.session import Database
from ..artifacts.store import ArtifactStore
from ..artifacts.versions import VersionStore
from ..attachments.store import (
    IMAGE_KIND,
    AttachmentRejected,
    AttachmentStore,
    kind_of,
)
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
from ..providers.leaks import leaked_tool_call, refused_images
from ..providers.base import (
    Capabilities,
    ChatRequest,
    ImagePart,
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


#: How the user appears in a teammate's mailbox. A name, not an agent id,
#: because it is rendered straight into the next agent's instruction and
#: "user says:" is what an agent needs to read there.
USER_SENDER = "The user"


class MissionAlreadyRunning(Exception):
    """Asked to continue a run that has not stopped."""

    def __init__(self, mission_id: str) -> None:
        super().__init__(mission_id)
        self.mission_id = mission_id


class MissionNotRunning(Exception):
    """A note was addressed to a mission that is not being driven right now."""

    def __init__(self, mission_id: str) -> None:
        super().__init__(mission_id)
        self.mission_id = mission_id


class UnknownTeammate(Exception):
    """A note was addressed to a name nobody on this team answers to.

    Carries the real names, because "no such teammate" is not something the
    person can act on and "did you mean Wren, Bo or Ilse" is.
    """

    def __init__(self, asked: str, names: list[str]) -> None:
        super().__init__(asked)
        self.asked = asked
        self.names = names


class MissionRejected(ValueError):
    """The team cannot run. Carries every blocking finding, because one reason at
    a time turns fixing a team into a guessing game (§5.2)."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


#: How much of the leader's closing message becomes the ending's summary.
#:
#: Sized to what `earlier_rounds` already reads back, so the next round is
#: handed the same text this one recorded rather than a shorter copy of it
#: (§2.1). The old 2,000 cut a real 3,837-character handover clean in half,
#: mid-word, at *"All of Test Plan sections 2+**, an"* — and that string is
#: the ending on the timeline, the text of `final-answer.md`, and the only
#: thing the next round's planner can read about what happened.
SUMMARY_CHARS = 4000


def shorten(text: str, limit: int = SUMMARY_CHARS) -> str:
    """`text`, cut at a word boundary and **saying** that it was cut.

    A summary is a label on a row, and the leader's own `agent.message` carries
    the whole thing on the log — so shortening is legitimate and losing the end
    of a sentence silently is not. A record that stops mid-word reads as the
    app having broken rather than having abbreviated (§1).
    """
    if len(text) <= limit:
        return text
    mark = " … (shortened — the whole message is on the timeline)"
    cut = text[: limit - len(mark)].rstrip()
    space = cut.rfind(" ")
    # Only back up to a word boundary if one is near the end; a single
    # enormous token must still be cut somewhere.
    if space > len(cut) - 120:
        cut = cut[:space]
    return f"{cut.rstrip()}{mark}"


def ending_for(
    reason: str, summary: str, task_states: dict[str, str]
) -> tuple[str, str]:
    """Correct `completed` to `failed` when nothing actually succeeded.

    Seen live: three tasks failed, no file was written, the leader's own summary
    said *"the deliverables were not produced"* — and the row said `completed`.
    Which also credited every agent on the team with a mission they had not
    finished, because `_finalise_team` counts a mission on that word (§1.1).

    **Any** failed task is enough. The first version only caught a run where
    nothing at all succeeded, and the very next run walked through the gap: the
    atlas task failed, the notes task succeeded, and the leader's own summary
    said *"index.html is missing, so the mission is not complete"* — over a row
    that said `completed`, crediting both agents again.

    There is no honest reading of "completed" that covers a run which did not
    do what it was asked. The nuance belongs in the summary, which says what
    was produced and what was not; the reason is a single word and has to be
    the true one.

    Any other reason wins: `cancelled`, `budget_exceeded` and `crashed` all say
    something more specific about why the work stopped.

    **Every ending also says what was left undone**, whatever the reason. A run
    asked for a tool, tests for it, and a test run produced the tool and was
    then killed by the clock during the first task. It ended honestly —
    `budget_exceeded`, *stopped at the time limit (1302/900)* — and said nothing
    about the two tasks that never started, so the only way to find out which
    part of the request was missing was to read the timeline and compare it to
    what you had asked for.

    Named separately, because they are different failures with different fixes:
    a task that **never started** ran out of room, and a task that **produced
    nothing** ran and came back empty.
    """
    # Normalised first. The map carries `(state, title)` now and read the tuple
    # as a state for one commit, which turned every finished run into a failed
    # one — caught by the M6 test that asserts a resumed mission completes.
    tasks = [state for state, _ in _states(task_states)]
    if reason == "completed" and tasks and any(state != "done" for state in tasks):
        # No honest reading of "completed" covers a run that did not do what it
        # was asked. The word has to be the true one.
        reason = "failed"
        summary = summary or (
            f"{sum(1 for s in tasks if s != 'done')} of {len(tasks)} tasks did not finish"
        )

    note = unfinished_note(task_states)
    if note:
        summary = f"{summary} — {note}" if summary else note
    return reason, summary


def _states(
    task_states: dict[str, tuple[str, str]] | dict[str, str],
) -> list[tuple[str, str]]:
    """`(state, title)` per task, whichever shape the caller kept.

    Two callers, and one of them predates the titles. A tuple read as a state
    silently makes every comparison true, which is how a passing suite briefly
    marked every completed mission `failed`.
    """
    return [
        value if isinstance(value, tuple) else (value, "")
        for value in task_states.values()
    ]


def unfinished_note(task_states: dict[str, tuple[str, str]] | dict[str, str]) -> str:
    """One sentence naming the work that did not get done, or "".

    Built from the task states the log already carries — no judgement, nothing
    asked of a model, nothing invented. A run whose every task is done says
    nothing, because there is nothing to say.
    """
    entries = _states(task_states)
    if not entries or all(state == "done" for state, _ in entries):
        return ""

    done = sum(1 for state, _ in entries if state == "done")
    parts = [f"{done} of {len(entries)} tasks done"]

    never = [label for state, label in entries if state not in {"done", "failed"} and label]
    empty = [label for state, label in entries if state == "failed" and label]
    if never:
        parts.append("never started: " + "; ".join(never))
    if empty:
        parts.append("produced nothing: " + "; ".join(empty))
    return ". ".join(parts)


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
        self._versions = VersionStore(db)
        self._attachments = AttachmentStore(db)
        #: What each paused mission needs in order to be resumed. Rebuilt from
        #: the database on restart, because the process that paused is gone.
        self._paused: dict[str, dict[str, Any]] = {}
        #: Tool approvals a *live* turn is waiting on: request id -> (mission,
        #: future). Unlike a plan approval these do not survive the process
        #: (§16.4). There is no checkpoint in the middle of a turn, so if this
        #: process dies the mission is crashed and the tool never ran - which
        #: is the safe direction to fail in.
        self._awaiting: dict[str, tuple[str, asyncio.Future[str]]] = {}
        #: The live mailbox of each running team mission, so a note typed while
        #: the team works has somewhere to go. Held here and nowhere else: it is
        #: not persisted, because what was said is on the event log (§2.1).
        self._mailboxes: dict[str, Mailbox] = {}
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
        limits = resolve_limits(
            mission=budget, app_default=await get_app_budget(self._db)
        )
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

    async def _refuse_missing_providers(self, roster: RosterSnapshot) -> None:
        """Refuse before the round starts if a member's endpoint is gone.

        A snapshot is frozen on purpose: who did the earlier rounds must not
        change retroactively (§5.1), so `provider_id` is never re-read from the
        agents table. The honest consequence is that **deleting a model
        endpoint makes every older run impossible to continue** — the id on the
        snapshot names a row that is not there any more.

        That was already true and was discovered the worst way: the round
        opened, the row went back to `running`, the plan message was published,
        and the first call died with
        `no_provider: Pepper has no usable provider profile` — an internal
        sentence, after a paragraph had been typed, over a run recorded
        `crashed` with `0 tokens`.

        So it is a refusal rather than a crash. Nothing is reopened, nothing is
        published, and the caller gets the same 409 shape the team validator
        uses, which the composer already lists in full.

        Deliberately **not** repaired by falling back to whatever endpoint that
        agent points at today. That would quietly rewrite what the run is made
        of, and the snapshot exists precisely so it cannot be (§5.1). The way
        forward is a new run, and the message says so.
        """
        wanted = {m.provider_id for m in roster.members if m.provider_id}
        async with self._db.session() as s:
            rows = (
                await s.execute(
                    select(ProviderProfile).where(ProviderProfile.id.in_(wanted))
                )
                if wanted
                else None
            )
            have = {p.id for p in rows.scalars().all()} if rows is not None else set()

        gone = [m for m in roster.members if (m.provider_id or "") not in have]
        if not gone:
            return
        names = ", ".join(sorted({m.name for m in gone}))
        raise MissionRejected(
            [
                f"the model endpoint this run was made with no longer exists, so "
                f"{names} cannot think. A run remembers the endpoint it started "
                f"with and never swaps it for another one, so this run cannot be "
                f"continued — start a new run with the same team to use the "
                f"endpoint you have now."
            ]
        )

    async def start_mission(
        self,
        *,
        team_id: str,
        goal: str,
        title: str | None = None,
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
            team=team,
            members=members,
            agents=agents,
            workspace_root=resolved_workspace,
            # Recorded here as what this run *started* under. It is no longer
            # what the gate reads: moving the switch takes effect on the next
            # tool call (see `tools/execution.py`). Kept on the snapshot because
            # it is a true thing about the launch, and because a replay should
            # be able to say what the run began with.
            autonomy=await get_autonomy(self._db),
        )
        # An agent can point at an endpoint that has since been deleted, so a
        # brand-new run has the same hole a continued one does.
        await self._refuse_missing_providers(roster)
        # The app default is read here rather than baked in, so the number a
        # run is stopped at is the one the settings panel shows.
        limits = resolve_limits(
            mission=budget,
            team_default=team.default_budget,
            app_default=await get_app_budget(self._db),
        )
        mission_id = f"mission-{uuid.uuid4()}"

        async with self._db.session() as s:
            s.add(
                Mission(
                    id=mission_id,
                    kind="mission",
                    team_id=team_id,
                    title=title or None,
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
                mission_id,
                roster,
                goal,
                limits,
                require_approval=require_approval,
                attached=await self._attached(mission_id),
            ),
            name=f"mission:{mission_id}",
        )
        self._track(mission_id, task)
        return mission_id

    async def fork_mission(
        self,
        mission_id: str,
        goal: str,
        *,
        title: str | None = None,
        require_approval: bool = False,
    ) -> str:
        """Start a new run from an existing one's team, workspace and limits.

        The thing this answers is "try it again, differently, without losing
        this one". Continuing appends to the same conversation and cannot be
        undone; starting fresh forgets the workspace and the team. A fork keeps
        both and leaves the original exactly as it is.

        **The roster is copied, not re-resolved.** The point of a fork is to
        compare two attempts, and re-reading the `agents` table would hand the
        new run whatever those agents look like today — so two runs that were
        meant to differ in one thing could differ in several, and neither
        record would say which (§5.1). The same argument as the snapshot
        itself, applied one level up.

        The workspace is **shared**, and that is the honest limitation rather
        than a decision to hide: two runs pointed at one folder write the same
        files. Nothing stops it, here or anywhere else in this app — the path
        is validated, never claimed — so the caller says so and the person
        chooses.
        """
        body = (goal or "").strip()
        if not body:
            raise ValueError("there is nothing to ask")

        async with self._db.session() as s:
            parent = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if parent is None or parent.kind != "mission" or not parent.roster_snapshot:
                raise MissionNotRunning(mission_id)
            roster = RosterSnapshot.from_json(parent.roster_snapshot)
            limits = resolve_limits(
                mission=parent.budget, app_default=await get_app_budget(self._db)
            )
            source_title = parent.title or parent.goal
            team_id = parent.team_id
            workspace = parent.workspace_root

            new_id = f"mission-{uuid.uuid4()}"
            s.add(
                Mission(
                    id=new_id,
                    kind="mission",
                    team_id=team_id,
                    title=title or f"{(source_title or 'Run')[:60]} (fork)",
                    goal=body,
                    status="running",
                    budget=limits.as_dict(),
                    # Copied verbatim. See the docstring: re-resolving would
                    # silently change the thing being compared.
                    roster_snapshot=parent.roster_snapshot,
                    workspace_root=workspace,
                    started_at=datetime.now(UTC),
                )
            )
            await s.commit()

        started: dict[str, Any] = {
            "kind": "mission",
            "teamId": team_id,
            "goal": body,
            # Which run this came from, on the log. A fork whose origin is only
            # in its title is a fork whose origin is a guess.
            "forkedFrom": mission_id,
        }
        if workspace:
            started["workspaceRoot"] = workspace
        await self._bus.publish(
            new_id, {"type": "mission.started", "payload": started}
        )
        await self._bus.publish(
            new_id, {"type": "user.message", "payload": {"content": body}}
        )

        task = asyncio.create_task(
            self._run_team(
                new_id,
                roster,
                body,
                limits,
                require_approval=require_approval,
                attached=await self._attached(new_id),
            ),
            name=f"mission:{new_id}",
        )
        self._track(new_id, task)
        return new_id

    async def _record_no_vision(self, roster: RosterSnapshot) -> None:
        """Mark every provider this run used as unable to read images.

        The whole roster rather than a guess at which member failed: they share
        the endpoint that refused, and a capability is a fact about the model,
        not about the agent that happened to hit it.
        """
        ids = {m.provider_id for m in roster.members if m.provider_id}
        if not ids:
            return
        async with self._db.session() as s:
            rows = (
                await s.execute(
                    select(ProviderProfile).where(ProviderProfile.id.in_(ids))
                )
            ).scalars().all()
            for profile in rows:
                profile.capabilities = {**(profile.capabilities or {}), "vision": False}
            await s.commit()

    async def _attached(self, mission_id: str) -> tuple[tuple[ImagePart, ...], str]:
        """Everything attached to this mission, split by how it reaches a model.

        All of it, not only this round's. A file attached three rounds ago is
        still what the conversation is about — dropping it would mean "look at
        that again" quietly not working — and the store is content-addressed,
        so the same file attached twice is one file and one part.

        Images come back as picture parts. Text files come back as one block of
        prose to put in front of the instruction, because that is the only way
        a text model reads anything.

        A file whose bytes have gone is skipped rather than fatal: the round is
        still worth running, and the timeline already recorded the attachment.
        """
        images: list[ImagePart] = []
        documents: list[str] = []
        for row in await self._attachments.for_mission(mission_id):
            try:
                if kind_of(row.mime) == IMAGE_KIND:
                    images.append(
                        ImagePart(
                            media_type=row.mime,
                            data_b64=self._attachments.as_base64(row),
                        )
                    )
                else:
                    documents.append(
                        f"--- {row.name} ({row.bytes:,} bytes) ---\n"
                        f"{self._attachments.as_text(row)}\n"
                        f"--- end of {row.name} ---"
                    )
            except AttachmentRejected:
                continue

        preamble = ""
        if documents:
            # Named as the user's own attachment, not wrapped in the untrusted
            # markers: the person running the mission chose this file, and
            # telling an agent to distrust what its user handed it would be
            # both wrong and confusing (§16.6 is about text fetched from
            # elsewhere).
            body = "\n\n".join(documents)
            preamble = f"The user attached these files:\n\n{body}"
        return tuple(images), preamble

    async def continue_mission(
        self, mission_id: str, goal: str, *, require_approval: bool = False
    ) -> str:
        """Ask a finished run to keep going, in the same conversation (§7.1).

        A round ending is not the mission ending. The old shape treated it as
        one: the composer's only offer after `mission.ended` was to start a
        *different* run, which meant a new row, a new empty timeline, and an
        agent that had forgotten the workspace it had just spent ten minutes
        learning. "Fix the spacing on the hero" is the most ordinary thing to
        want next, and it was the one thing the app could not do.

        So the mission row is reopened and the graph runs again over the **same
        frozen roster** — never re-read from the agents table, because who did
        the earlier rounds must not change retroactively (§5.1) — appending to
        the same event log.

        Each round gets a fresh budget. The alternative, one ceiling across
        every round, means a second question is refused because the first was
        answered thoroughly; and the rail counts a round's tokens against a
        round's limit, so the two agree.
        """
        body = (goal or "").strip()
        if not body:
            raise ValueError("there is nothing to send")
        if self.is_running(mission_id):
            raise MissionAlreadyRunning(mission_id)

        async with self._db.session() as s:
            mission = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if mission is None:
                raise MissionNotRunning(mission_id)
            if mission.kind != "mission" or not mission.roster_snapshot:
                # A chat has no team and no graph to re-enter.
                raise MissionNotRunning(mission_id)
            roster = RosterSnapshot.from_json(mission.roster_snapshot)
            limits = resolve_limits(
                mission=mission.budget, app_default=await get_app_budget(self._db)
            )
            earlier = await self.earlier_rounds(mission_id, mission.goal)
            # Before the row is reopened and before a single event is
            # published: a refusal that has already restarted the mission is a
            # run left saying `running` over nothing.
            await self._refuse_missing_providers(roster)
            # Reopened, and the row says so before the first event of the round.
            mission.status = "running"
            mission.end_reason = None
            mission.ended_at = None
            mission.goal = body
            await s.commit()

        await self._bus.publish(
            mission_id, {"type": "user.message", "payload": {"content": body}}
        )

        task = asyncio.create_task(
            self._run_team(
                mission_id,
                roster,
                body,
                limits,
                # A round can be gated too. It never could before: the flag was
                # only ever set by `start_mission`, so seeing the plan first was
                # something you could ask for once and never again in the same
                # conversation — while the plan is the one point where stopping
                # still saves the cost of the work.
                require_approval=require_approval,
                attached=await self._attached(mission_id),
                earlier=earlier,
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
        #: (pictures, text put in front of every instruction) — see `_attached`.
        attached: tuple[tuple[ImagePart, ...], str] = ((), ""),
        #: What earlier rounds did, for the planner. See `earlier_rounds`.
        earlier: str = "",
    ) -> None:
        images, documents = attached
        budget = BudgetTracker(limits)
        opened: dict[str, LLMProvider] = {}
        reason, summary = "completed", ""
        #: Which ceiling stopped the run, when one did.
        limit_kind: str | None = None
        parked = False
        #: taskId -> its latest state, read off the events on their way past.
        #: "completed" has to mean something was completed (see the finally).
        #: taskId -> (state, title), read off the events on their way past.
        task_states: dict[str, tuple[str, str]] = {}
        #: callId -> (agentId, path) for file writes still in flight. The end
        #: event says whether it worked; the start event says what it was.
        written: dict[str, tuple[str, str]] = {}
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

        # Looked up once for the mission: every search endpoint that has a key,
        # in the order they were added. More than one is the point — a free
        # allowance runs out, and the next key takes over rather than the tool
        # failing (§16.5). A tool never reads the keychain itself (§9.2), and
        # `web_search` is simply not offered when there is nothing behind any of
        # them (§15 row 32).
        search_endpoints: list[SearchEndpoint] = []
        async with self._db.session() as session:
            rows = await session.execute(
                select(ProviderProfile)
                .where(ProviderProfile.kind == "search")
                # The order the user put them in, not the order they were
                # added. Shared with the panel that shows it (registry).
                .order_by(*registry.search_order())
            )
            for profile in rows.scalars().all():
                if key := secrets.get_key(profile.id):
                    search_endpoints.append(
                        SearchEndpoint(
                            api_key=key,
                            base_url=profile.base_url or DEFAULT_SEARCH_ENDPOINT,
                        )
                    )

        # One mailbox for the mission. Not persisted: what was said is on the
        # event log, and a second copy would be a second thing to keep true.
        mailbox = Mailbox({m.agent_id: m.name for m in roster.members})
        self._mailboxes[mission_id] = mailbox


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
                # Same rule as a tool approval: a mission waiting on a person is
                # not a mission working, and its timeout should not say it is.
                with budget.paused_for_a_person():
                    return await waiting
            except asyncio.CancelledError:
                # The mission ended while the question was on screen. Reported
                # to the tool as unanswered rather than swallowed.
                return None

        met_requirements = {"workspace"} if roster.workspace_root else set()
        if search_endpoints:
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
                        **({"search": search_endpoints} if search_endpoints else {}),
                    },
                ),
                autonomy=member.autonomy,
                # Read per gated call, so "never ask" stops the questions on
                # the next one rather than on the next run. `member.autonomy`
                # above stays as what the run started under.
                live_autonomy=lambda: get_autonomy(self._db),
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
                images=images,
                documents=documents,
                earlier=earlier,
            ):
                # The same routing split a chat uses (§7.1), in the same place.
                if is_ephemeral(item):
                    self._bus.broadcast_ephemeral(item)
                else:
                    await self._bus.publish(mission_id, item)
                    if item["type"] == "agent.message":
                        # A leaked tool-call template is not what this round
                        # achieved, and it was becoming the whole summary.
                        body = item["payload"]["content"]
                        if not leaked_tool_call(body):
                            summary = shorten(body)
                    elif item["type"] in ("agent.tool.start", "agent.tool.end"):
                        await self._note_written(mission_id, item, written)
                    elif item["type"] == "mission.progress":
                        progress = item["payload"]
                        # The label too, so an ending can name what was left
                        # rather than counting it.
                        task_states[progress["taskId"]] = (
                            progress["state"],
                            str(progress.get("label") or ""),
                        )

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
            limit_kind = exc.kind
            summary = f"stopped at the {exc.kind} limit ({exc.used}/{exc.limit})"
        except PlanningFailed as exc:
            # Said in this app's words, not Pydantic's. The person saw
            # `tasks.0.instruction: String should have at most 2000 characters`
            # — twice, once as the error and once as the ending — which names
            # an array index, uses a vocabulary that appears nowhere else in
            # the app, and gives nothing to do about it. It was also only the
            # **last** of three attempts: `str(exc)` is `attempts[-1]` and the
            # other two were discarded.
            reason = "failed"
            who = roster.leader.name if roster.leader else "The leader"
            tried = len(exc.attempts) or 1
            summary = (
                f"{who} could not produce a workable plan — {tried} attempts, "
                "each one rejected, so no task was started. Asking for less in "
                "one round, or splitting the work, is usually what fixes it."
            )
            # Every attempt, on the log, where the detail belongs: a person
            # reads the sentence and whoever is debugging reads the reasons,
            # and neither has to make do with the other's.
            await self._publish_error(
                mission_id,
                "planning_failed",
                f"{summary} What was wrong each time: "
                + "; ".join(f"({i}) {why}" for i, why in enumerate(exc.attempts, 1)),
                False,
            )
        except ProviderError as exc:
            reason, summary = "failed", exc.message
            # The endpoint has just told us something true about its model.
            # Written down so the next attempt can say so before spending a
            # round discovering it — the same rule as the capability probe:
            # record only what was actually established (§3.1).
            if refused_images(exc.message):
                await self._record_no_vision(roster)
                summary = (
                    "this model does not accept images — attach them to a run "
                    "whose model can read them"
                )
            await self._publish_error(mission_id, exc.code, summary, exc.recoverable)
        except Exception as exc:  # noqa: BLE001 - a crash must still be recorded
            reason, summary = "crashed", f"{type(exc).__name__}: {exc}"
            await self._publish_error(mission_id, "internal_error", summary, False)
        finally:
            # A parked mission has not ended - it is waiting on a person, and
            # finalising it here would close it seconds after it asked its
            # question, with `completed` still sitting in `reason`.
            # Written here, not as each task changes. The first version awaited
            # a database write inside the `async for` that drains the graph,
            # and that extra suspension point was enough to let the finaliser
            # run before a pause was recorded — seven HITL tests went from
            # `waiting` to `ended`. The counts are for the *list* of past runs;
            # the run in front of you has a header that counts its own log.
            await self._save_task_counts(mission_id, task_states)
            if parked:
                return
            # The work phase can stop on the reserve and still reach the end of
            # the graph, having spent what was left saying where it got to. No
            # exception is raised on that path — deliberately, because the
            # summary is the point of it — so the reason has to be corrected
            # here or a run that ran out would be recorded `completed`.
            #
            # The summary the leader wrote is kept: it is the handover, and it
            # is worth far more than the sentence this would otherwise put
            # there. The numbers go in front of it, so the record still says
            # plainly which limit stopped the run.
            if budget.stopped_early is not None and reason == "completed":
                kind, used, limit = budget.stopped_early
                reason = "budget_exceeded"
                limit_kind = kind
                stopped = f"stopped at the {kind} limit ({used:.0f}/{limit:.0f})"
                summary = f"{stopped} — {summary}" if summary else stopped
            reason, summary = ending_for(reason, summary, task_states)
            # Scheduled, never awaited here: this block also runs while the task
            # is being cancelled, and an await would be cancelled with it.
            self._finishers[mission_id] = asyncio.create_task(
                self._finalise_team(
                    mission_id, list(opened.values()), roster, reason, summary, limit_kind
                ),
                name=f"finalise:{mission_id}",
            )

    #: Tools whose success means a file now exists in the workspace.
    #:
    #: The list lives in the registry, which is where facts about tools go.
    #: Kept as a class attribute so existing callers and tests still reach it
    #: by this name.
    FILE_TOOLS = tool_registry.FILE_TOOLS

    async def _note_written(
        self,
        mission_id: str,
        item: dict[str, Any],
        pending: dict[str, tuple[str, str]],
    ) -> None:
        """Make the files an agent produced visible to the app.

        `artifact.created` used to be published from exactly one place — the
        `final-answer.md` written when a run completed — so the Files tab read
        **Files 0** over a workspace holding twenty files and a Next.js app that
        built. The one thing a run is for was the one thing the app could not
        show, and every assessment of a team's work had to be done in Explorer.

        Watched here rather than emitted by the runtime, which has no database
        and should not grow one: the runner already reads every draft on its way
        to the bus, and correlating a start with its end by `callId` is the
        whole of it.

        A second write to the same path is the same file written twice, so the
        row is refreshed and no second `created` goes on the log — a timeline
        that said a file was created four times would be describing four files.
        """
        payload = item.get("payload") or {}
        call_id = str(payload.get("callId") or "")
        if not call_id:
            return

        if item["type"] == "agent.tool.start":
            if payload.get("tool") in self.FILE_TOOLS:
                path = str((payload.get("input") or {}).get("path") or "")
                if path:
                    pending[call_id] = (str(payload.get("agentId") or ""), path)
            return

        agent_and_path = pending.pop(call_id, None)
        if agent_and_path is None or not payload.get("ok"):
            # A failed write produced nothing, and listing it would put a file
            # on screen that is not there.
            return
        agent_id, path = agent_and_path

        async with self._db.session() as session:
            mission = (
                await session.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            workspace = mission.workspace_root if mission else None
        if not workspace:
            return

        try:
            artifact, is_new = await self._artifacts.note_workspace_file(
                mission_id=mission_id,
                agent_id=agent_id or None,
                relative=path,
                workspace_root=workspace,
            )
        except Exception as exc:  # noqa: BLE001 - the file exists either way
            await self._publish_error(
                mission_id, "artifact_note_failed", str(exc), True
            )
            return
        # What the file holds now, kept so the Files tab can show what changed
        # rather than only how many bytes did. Read back from the workspace
        # rather than reconstructed from the tool's arguments: if someone edited
        # the file in an editor between two agent writes, that edit belongs
        # inside the next diff, attributed to nobody, because that is what
        # happened.
        #
        # Recorded on every write, not only the first — the version *is* the
        # change, and a file written eleven times has eleven of them.
        await self._versions.record(
            mission_id=mission_id,
            path=path,
            workspace_root=workspace,
            agent_id=agent_id or None,
            event_id=str(item.get("id") or call_id),
        )

        if not is_new:
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
                    "source": "workspace",
                },
            },
        )

    async def _save_task_counts(
        self, mission_id: str, task_states: dict[str, tuple[str, str]]
    ) -> None:
        """How far through the plan this round is, on the mission row.

        The states come from the same `_states` normaliser the ending uses, so
        the sidebar's "10 of 12" and the ending's "10 of 12 tasks done" cannot
        drift apart — two readings of one thing rather than two counts (§2.1).
        """
        # `_states` returns a *list* of (state, title) pairs, not a mapping —
        # its whole reason for existing is that one caller kept titles and the
        # other did not.
        states = _states(task_states)
        if not states:
            # A round that never got as far as a plan has nothing to say about
            # how far the plan got, and `0 of 0` is not that — it erases what
            # the round before it achieved. Seen on a real run: a retry that
            # died in planning overwrote `4 of 6`, which took the sidebar's
            # shortfall badge and the launch form's own budget evidence with it.
            # Saying nothing keeps the last true reading (§5.1).
            return
        done = sum(1 for state, _title in states if state == "done")
        async with self._db.session() as session:
            mission = (
                await session.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if mission is None:
                return
            mission.tasks_done = done
            mission.tasks_total = len(states)
            await session.commit()

    async def earlier_rounds(self, mission_id: str, current_goal: str) -> str:
        """What the rounds before this one asked for and what came of them.

        Read off `mission_events`, not stored anywhere. The log is the record
        (§2.1), and a second place saying what a run achieved is a second place
        to be wrong — a status file that says "done: the admin pages" when they
        were never written is worse than no file at all.

        The planner used to get the new message alone, so "carry on" was a goal
        that read, in full, "carry on". It could not see the earlier
        instruction, and it could not see the handover **it had written itself
        one event earlier** — which named every file, what was missing and what
        to do first, and was read by nobody but a person.

        Deliberately short: each round's instruction and its ending. The
        detail lives in the workspace, which the workers can open, and paying
        to re-read a whole log on every continue is how a conversation gets
        more expensive the longer it goes on.
        """
        async with self._db.session() as session:
            rows = (
                (
                    await session.execute(
                        select(MissionEvent)
                        .where(MissionEvent.mission_id == mission_id)
                        .where(MissionEvent.type.in_(("user.message", "mission.ended")))
                        .order_by(MissionEvent.seq)
                    )
                )
                .scalars()
                .all()
            )

        lines: list[str] = []
        for row in rows:
            payload = row.payload or {}
            if row.type == "user.message":
                lines.append(f"You were asked: {str(payload.get('content', ''))[:1500]}")
            else:
                ended = str(payload.get("summary", "")).strip()
                reason = str(payload.get("reason", ""))
                lines.append(
                    f"That round ended ({reason}).\n{ended[:4000]}"
                    if ended
                    else f"That round ended ({reason})."
                )

        # The row's own goal is overwritten by each new message, so a mission
        # whose log predates this reader still has one instruction to show.
        if not lines and current_goal:
            lines.append(f"You were asked: {current_goal[:1500]}")
        return "\n\n".join(lines)

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
        limit: str | None = None,
    ) -> None:
        self._abandon_waiting(mission_id)
        self._mailboxes.pop(mission_id, None)
        for provider in providers:
            try:
                await provider.aclose()
            except Exception:  # noqa: BLE001 - a failed close must not lose the event
                pass
        if reason == "completed":
            await self._credit_missions(roster)
            await self._save_answer(mission_id, roster, summary)
        await self._finish(mission_id, reason, summary, limit)

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
        # A continued round gets a fresh budget, and it gets the *current*
        # app default: raising the ceiling should reach the next round of a
        # conversation, not only brand new runs.
        limits = resolve_limits(
            mission=mission.budget, app_default=await get_app_budget(self._db)
        )
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

        One `UPDATE ... SET total_missions = total_missions + 1`, not a read
        followed by a write. Nothing stops a team running two missions at once,
        and read-modify-write across two of them loses a count: both read N,
        both write N+1, and an agent that finished two runs is credited with
        one. The database can add without being told the old value, so it does.
        """
        agent_ids = [m.agent_id for m in roster.members]
        if not agent_ids:
            return
        async with self._db.session() as s:
            await s.execute(
                update(Agent)
                .where(Agent.id.in_(agent_ids))
                .values(total_missions=Agent.total_missions + 1)
            )
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

    async def note(
        self, mission_id: str, content: str, *, to: str | None = None
    ) -> str:
        """Deliver a message to a team that is already working (§7.1).

        There is no way to interrupt a turn in flight — the model is mid-reply
        and nothing can reach it — and pretending otherwise would be the UI
        lying about the system. What this does instead is put the note in every
        member's mailbox, which each one collects **when their next task
        starts**. So it lands at the next step boundary, and the UI says exactly
        that rather than "sent".

        The same mailbox teammates use, on purpose: a second delivery path would
        be a second thing to keep working, and this one is already collected in
        the right place.

        `to` addresses one teammate. Without it the note goes to everybody,
        which is what a note has always been — so "@Wren check that file again"
        stops making the other three read an instruction that is not theirs.
        The name is resolved by the same `Mailbox.resolve` an agent's
        `send_message` uses: exact, then prefix, then contains, and `Ambiguous`
        rather than a guess. Delivering to the wrong person and reporting
        success is the worst failure available here, and it is the same rule
        whether the sender is an agent or the user.
        """
        body = (content or "").strip()
        if not body:
            raise ValueError("there is nothing to send")

        mailbox = self._mailboxes.get(mission_id)
        if mailbox is None or not self.is_running(mission_id):
            raise MissionNotRunning(mission_id)

        recipients = mailbox.recipients()
        addressed: str | None = None
        if to is not None:
            # Ambiguous propagates: two teammates who both fit is a question
            # for the person, not something to resolve by picking one.
            addressed = mailbox.resolve(to)
            if addressed is None:
                raise UnknownTeammate(to, mailbox.names())
            recipients = [addressed]

        # On the log first: this is the user speaking, and the timeline is the
        # record of what was said (§1). It is the same event a run starts with.
        #
        # `to` rides on the event rather than being kept beside it, because a
        # replay has to be able to say a note went to one person. A note that
        # looked like a broadcast in the record and was not is the timeline
        # being untrue about what happened.
        payload: dict[str, Any] = {"content": body}
        if addressed is not None:
            payload["to"] = addressed
        await self._bus.publish(
            mission_id, {"type": "user.message", "payload": payload}
        )
        for agent_id in recipients:
            mailbox.post(sender=USER_SENDER, recipient=agent_id, content=body)
        return body


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

    async def _finish(
        self, mission_id: str, reason: str, summary: str, limit: str | None = None
    ) -> None:
        """Every mission ends with exactly one `mission.ended`, carrying why.

        `ok: true/false` was not enough: completed, budget_exceeded, cancelled
        and crashed have to look different in the timeline and in the scene
        (§15 row 8).
        """
        await self._bus.publish(
            mission_id,
            {
                "type": "mission.ended",
                "payload": {
                    "reason": reason,
                    "summary": summary,
                    # Which of the four, when one of them is why. "Out of
                    # budget" was one phrase for tokens, calls, supersteps and
                    # time — four problems with four different fixes — and the
                    # only place the real one appeared was inside the summary
                    # prose. Three runs in a row were stopped by the clock and
                    # read as having run out of tokens, including by the person
                    # writing this file, who then went looking for the tokens.
                    **({"limit": limit} if limit else {}),
                },
            },
        )
        async with self._db.session() as s:
            mission = (
                await s.execute(select(Mission).where(Mission.id == mission_id))
            ).scalar_one_or_none()
            if mission is not None:
                mission.status = "ended"
                mission.ended_at = datetime.now(UTC)
                mission.end_reason = reason
                mission.end_limit = limit
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
