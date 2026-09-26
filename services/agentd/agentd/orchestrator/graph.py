"""The team mission: plan, work, summarise (PROJECT_BRIEF.md §7, §12 M4).

Built as an async generator, exactly like `run_agent_turn`. It yields drafts and
ephemeral frames and never touches the bus — so `MissionRunner` routes a team
mission through the same single code path as a chat, and the whole orchestrator
is testable with no bus, no database and no network.

**Nothing here reads the `agents` or `team_members` tables.** It is handed a
`RosterSnapshot` and that is the entire world (§5.1). That is what makes the M4
criterion true: edit an agent after the run and the replay still shows the name,
the model and the avatar that actually did the work.

LangGraph owns the control flow rather than a hand-written loop because M6 needs
its `interrupt()` and checkpointer for human-in-the-loop that survives a restart.
Nodes push events onto a queue that this generator drains, since a graph node
returns state and cannot yield.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from ..agents.runtime import is_ephemeral, run_agent_turn
from ..core.budget import BudgetExceeded, BudgetTracker
from ..providers.base import (
    Capabilities,
    ChatRequest,
    ImagePart,
    LLMProvider,
    Message,
)
from ..teams.snapshot import RosterSnapshot, SnapshotMember
from ..tools.execution import ToolBox
from ..tools.registry import FILE_TOOLS
from .hitl import APPROVE, Ask, PlanRejected, ask_to_approve, new_request_id, pause
from .planner import _WRITES_A_FILE, PlanningFailed, make_plan

#: Resolves a snapshot member to a live provider + capabilities. Injected so the
#: graph never learns which vendor anything is (§3.1).
ProviderFor = Callable[[SnapshotMember], "tuple[LLMProvider, Capabilities]"]

#: Resolves a snapshot member to the tools it may use, already scoped to this
#: mission's workspace and this agent's autonomy (§16). Injected for the same
#: reason as `provider_for`: the graph decides nothing about permission.
ToolsFor = Callable[[SnapshotMember], "ToolBox | None"]

#: A reasoning model can spend thousands of tokens before its first visible
#: character. At 4096 a live run produced an empty answer and a truncation
#: error, and the teammate downstream had nothing to work from.
#: Output ceiling for one worker turn. **Reasoning tokens count against it**,
#: which is what makes the number hard.
#:
#: 4096 was too small: a worker spent it all thinking and emitted an empty
#: answer. 8192 was too small too, and failed in a worse way — on a creative
#: task the model spent the whole budget reasoning and produced *neither text
#: nor a tool call*, so the prompt rule about writing files never got a chance
#: to apply. Three tasks in a row failed that way and the workspace stayed
#: empty.
#:
#: A cap that is too low does not cost less. It costs the entire turn and buys
#: nothing, and then the next agent pays again to discover there is no file.
MAX_TOKENS_PER_TASK = 16384

#: How many tasks may be in flight together.
#:
#: Not unbounded: every task in a wave is a separate conversation with the same
#: endpoint, and five at once is a rate limit rather than five times the speed.
#: Three is enough to overlap the waiting without turning one mission into a
#: burst that looks like abuse.
MAX_PARALLEL = 3

#: Tokens held back for each task still queued behind the one running.
#:
#: One implementation task spent a whole 200,000-token run and the three review
#: tasks behind it never started — so the files were written and nobody checked
#: them, which is the worst half to lose. 79% of that spend was the growing
#: conversation being re-sent, not new work.
#:
#: A floor, not a share: a task may use everything except what the tasks after
#: it need to run at all. Enough to read a few files and answer.
RESERVE_PER_QUEUED_TASK = 20_000

#: However tight things are, a task gets at least this much or it cannot even
#: read the workspace, and reporting "stopped" without having looked is worse
#: than not running it.
MIN_TASK_ALLOWANCE = 12_000


def task_allowance(remaining_tokens: int, queued_after: int) -> int:
    """What one task may spend, leaving the rest of the plan able to run."""
    return max(
        MIN_TASK_ALLOWANCE,
        remaining_tokens - RESERVE_PER_QUEUED_TASK * max(0, queued_after),
    )


def _plan_text(tasks: list[dict[str, Any]], snapshot: RosterSnapshot | None = None) -> str:
    """The plan as the leader wrote it, with what runs together made visible.

    A numbered list alone cannot show that tasks 1 and 2 will start at the same
    moment, and that is exactly the thing worth reading before approving a plan.
    Mentioned only when something actually shares a wave — a sequential plan
    says nothing extra, because there is nothing extra to say.
    """
    # By name, not by seat. "→ seat 2" is this app's internal coordinate, and
    # the person reading the plan — deciding whether to approve it — has no way
    # to know who seat 2 is. The seat is still what the runner assigns on; it
    # is simply not what a sentence for a human should say.
    def who(seat: Any) -> str:
        if snapshot is not None:
            for member in snapshot.members:
                if member.seat_index == seat:
                    return member.name
        return f"seat {seat}"

    lines = [
        f"{i + 1}. {t['title']} → {who(t['assignee_seat'])}"
        for i, t in enumerate(tasks)
    ]
    together = [wave for wave in plan_waves(tasks) if len(wave) > 1]
    if together:
        lines.append("")
        for wave in together:
            lines.append("At the same time: " + ", ".join(str(i + 1) for i in wave))
    return "Plan:\n" + "\n".join(lines)


def plan_waves(tasks: list[dict[str, Any]]) -> list[list[int]]:
    """Group task indices into waves that may run together.

    A task's `depends_on` is honoured as written, and **an absent one means
    "after the task before it"** — the behaviour every plan had before the field
    existed. So a plan that never mentions dependencies comes back as one task
    per wave, exactly sequential, and nothing runs in parallel unless the leader
    said it could.

    Order inside a wave is the order the leader listed them, so the record reads
    the way the plan does.
    """
    waiting: list[set[str]] = []
    for index, task in enumerate(tasks):
        declared = task.get("depends_on")
        if declared is None:
            waiting.append({tasks[index - 1]["id"]} if index > 0 else set())
        else:
            waiting.append(set(declared))

    known = {task["id"] for task in tasks}
    done: set[str] = set()
    placed: set[int] = set()
    waves: list[list[int]] = []

    while len(placed) < len(tasks):
        ready = [
            index
            for index in range(len(tasks))
            if index not in placed
            # A dependency on something outside the plan cannot be waited for.
            # The planner rejects those, so this only guards a corrupted plan:
            # dropping the edge runs the task rather than hanging the mission.
            and (waiting[index] & known) <= done
        ]
        if not ready:
            # Unreachable through the planner, which refuses cycles. A cycle
            # that got here anyway runs the rest in listed order rather than
            # stalling for ever.
            ready = [index for index in range(len(tasks)) if index not in placed]
        waves.append(ready)
        placed.update(ready)
        done.update(tasks[index]["id"] for index in ready)

    return waves


class MissionState(TypedDict, total=False):
    goal: str
    tasks: list[dict[str, Any]]
    results: list[dict[str, Any]]
    summary: str


class Paused(Exception):
    """The graph stopped at an `interrupt()` and is waiting for a person.

    Not an error. The runner turns it into `status = "waiting"` and a
    `pending_request`, and the mission sits there until someone answers -
    across a restart if need be (§12 M6).
    """

    def __init__(self, ask: Ask) -> None:
        super().__init__(ask.question)
        self.ask = ask


def _draft(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": event_type, "payload": payload}


async def run_team_mission(
    *,
    mission_id: str,
    snapshot: RosterSnapshot,
    goal: str,
    budget: BudgetTracker,
    provider_for: ProviderFor,
    tools_for: ToolsFor | None = None,
    checkpointer: Any | None = None,
    require_approval: bool = False,
    resume: str | None = None,
    #: What earlier rounds of this mission did, for the planner. Empty on a
    #: mission's first round.
    earlier: str = "",
    #: Images the user attached to this round, handed to the turns that need
    #: to see them: the work turns, because the graph cannot know in advance
    #: which agent picks up the task the picture is about, and the summary turn,
    #: because a leader writing the run's final answer is describing the same
    #: thing. Not the planning turn — a plan is made from the goal, and the one
    #: turn that never quotes the picture is the one worth not paying for.
    #:
    #: They are re-sent per turn, which is the honest price of the agents who
    #: need them being able to see them.
    images: tuple[ImagePart, ...] = (),
    #: Text files the user attached, already formatted, to go in front of every
    #: instruction. A text model reads a file no other way.
    documents: str = "",
) -> AsyncIterator[dict[str, Any]]:
    """Run a team to completion, narrating every step as events.

    `resume` re-enters a mission that stopped at an approval. The graph picks up
    from its checkpoint, which may have been written by a process that no longer
    exists - that is the whole point of the checkpointer (§12 M6).
    """
    leader = snapshot.leader
    if leader is None:
        # Unreachable through the API — the validator blocks a leaderless team
        # before launch (§5.2) — but the graph must not assume its caller checked.
        raise ValueError("a team mission needs a leader")

    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def emit(item: dict[str, Any]) -> None:
        await queue.put(item)

    graph = _build_graph(
        mission_id=mission_id,
        snapshot=snapshot,
        budget=budget,
        provider_for=provider_for,
        tools_for=tools_for,
        emit=emit,
        require_approval=require_approval,
        checkpointer=checkpointer,
        resuming=resume is not None,
        images=images,
        documents=documents,
        earlier=earlier,
    )

    # One thread per mission, so a resume finds the right checkpoint even when
    # the process that wrote it is gone.
    config = {"configurable": {"thread_id": mission_id}} if checkpointer else {}

    async def drive() -> None:
        try:
            entry: Any = (
                Command(resume=resume)
                if resume is not None
                else {"goal": goal, "tasks": [], "results": []}
            )
            result = await graph.ainvoke(entry, config)
            # LangGraph reports an interrupt in the result rather than raising,
            # so a pause has to be recognised here and handed to the runner.
            pending = (result or {}).get("__interrupt__") if isinstance(result, dict) else None
            if pending:
                payload = getattr(pending[0], "value", None) or {}
                raise Paused(
                    Ask(
                        request_id=str(payload.get("requestId", new_request_id())),
                        kind=payload.get("kind", "approval"),
                        agent_id=str(payload.get("agentId", "")),
                        question=str(payload.get("question", "")),
                        options=payload.get("options"),
                    )
                )
        finally:
            await queue.put(None)

    task = asyncio.create_task(drive(), name=f"graph:{mission_id}")
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        # Surfaces BudgetExceeded, PlanningFailed and ProviderError to the
        # runner, which turns each into the right mission.ended reason.
        await task
    finally:
        if not task.done():
            # The caller closed us — a cancel. Take the graph down with it
            # rather than leaving a detached task spending money.
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def _build_graph(
    *,
    mission_id: str,
    snapshot: RosterSnapshot,
    budget: BudgetTracker,
    provider_for: ProviderFor,
    tools_for: ToolsFor | None = None,
    emit: Callable[[dict[str, Any]], Any],
    require_approval: bool = False,
    checkpointer: Any | None = None,
    resuming: bool = False,
    images: tuple[ImagePart, ...] = (),
    documents: str = "",
    #: What earlier rounds of this mission did, for the planner.
    earlier: str = "",
):
    leader = snapshot.leader
    assert leader is not None

    async def plan_node(state: MissionState) -> MissionState:
        for warning in budget.record_superstep():
            await emit(warning)
        budget.check()

        await emit(
            _draft("agent.status", {"agentId": leader.agent_id, "status": "thinking"})
        )
        provider, caps = provider_for(leader)
        try:
            result = await make_plan(
                provider=provider,
                caps=caps,
                model=leader.model or "",
                snapshot=snapshot,
                goal=state["goal"],
                earlier=earlier,
            )
        except PlanningFailed as exc:
            # Three attempts against a reasoning model is real money, and it
            # was landing nowhere: `PlanningFailed` has carried its usage all
            # along and nothing read it, so a round that failed to plan
            # recorded zero tokens on a log that is the only account of what
            # was spent. The rail truthfully read `Tokens used 0` over a
            # 50-second planning failure.
            #
            # This is the same gap `agent.usage` was added to close for a round
            # that called tools and said nothing: the cost is real whether or
            # not there is a message to hang it on (§1).
            await emit(
                _draft(
                    "agent.usage",
                    {
                        "agentId": leader.agent_id,
                        "messageId": f"plan-{mission_id}-failed",
                        "usage": exc.usage.to_event_usage(),
                    },
                )
            )
            # `exc.usage` is the **total** across every attempt, not one
            # attempt's — so the tokens go on once, and the remaining attempts
            # are booked as calls with no usage. Counting the total per attempt
            # would treble it, which is the kind of made-up number the budget
            # panel exists not to show (§1.1).
            #
            # The call ceiling counts requests, and three were made.
            # `record_call` only increments and returns warnings — it cannot
            # raise — so the ending below is reached either way.
            for index, _attempt in enumerate(exc.attempts):
                usage = exc.usage.to_event_usage() if index == 0 else None
                for warning in budget.record_call(usage):
                    await emit(warning)
            raise
        for warning in budget.record_call(result.usage.to_event_usage()):
            await emit(warning)

        # A plan that needed correcting is a fact about the model, not something
        # to tidy away (§1).
        for problem in result.recovered_from:
            await emit(
                _draft(
                    "error",
                    {
                        "agentId": leader.agent_id,
                        "code": "plan_corrected",
                        "message": f"the plan was rejected and retried: {problem}",
                        "recoverable": True,
                    },
                )
            )

        # Not the same fact as a rejection, so not the same sentence. Nothing
        # was rejected and no attempt was spent: there was one teammate who
        # could do the work, so this side moved it rather than asking a model
        # to guess the only legal answer and failing the run when it did not.
        for move in result.repaired:
            await emit(
                _draft(
                    "error",
                    {
                        "agentId": leader.agent_id,
                        "code": "plan_repaired",
                        "message": f"the plan was corrected without retrying: {move}",
                        "recoverable": True,
                    },
                )
            )

        tasks = [t.model_dump() for t in result.plan.tasks]
        await emit(
            _draft(
                "agent.message",
                {
                    "agentId": leader.agent_id,
                    "messageId": f"plan-{mission_id}",
                    "to": {"kind": "broadcast"},
                    # The waves are shown, not just the tasks. Running two
                    # things at once happens because the leader said they are
                    # independent, and a claim nobody can read is not one the
                    # approval gate can be used to check (§1).
                    "content": _plan_text(tasks, snapshot),
                    "usage": result.usage.to_event_usage(),
                },
            )
        )
        for i, t in enumerate(tasks):
            await emit(
                _draft(
                    "mission.progress",
                    {
                        "taskId": t["id"],
                        "label": t["title"],
                        "state": "pending",
                        "done": 0,
                        "total": len(tasks),
                        # Only here, on the event that announces the task. The
                        # plan message renders titles and seats — enough to
                        # approve a plan, not enough to run one task again, so
                        # a task that failed could only be retried by paying
                        # for the whole round.
                        "instruction": str(t.get("instruction") or ""),
                    },
                )
            )
        await emit(
            _draft("agent.status", {"agentId": leader.agent_id, "status": "idle"})
        )
        return {"tasks": tasks}

    async def approve_node(state: MissionState) -> MissionState:
        """Put the plan in front of the user before any of it is paid for.

        This gate is here rather than at the end because it is the only point
        where stopping still saves anything: after the work runs, the money is
        already spent.
        """
        if not require_approval:
            return {}

        tasks = state.get("tasks") or []
        summary = "\n".join(
            f"{i + 1}. {t['title']} (seat {t['assignee_seat']})"
            for i, t in enumerate(tasks)
        )
        ask = ask_to_approve(
            agent_id=leader.agent_id,
            request_id=new_request_id(),
            summary=summary,
        )
        # Resuming re-executes this node from the top: everything above an
        # `interrupt()` runs a second time, because the node's writes were never
        # committed. Emitting again puts a second question on the log carrying a
        # fresh id that nothing is waiting on - a live client would raise a modal
        # whose answer comes back 409, and a replay would show the leader asking
        # twice and being answered once. Seen on a real run, at seq 11.
        if not resuming:
            # Recorded before the pause: a replay has to show the question even
            # if nobody ever answers it.
            await emit(_draft("agent.request", ask.to_payload()))
            await emit(
                _draft(
                    "agent.status",
                    {"agentId": leader.agent_id, "status": "waiting"},
                )
            )

        answer = pause(ask)
        if answer.strip().lower() != APPROVE:
            raise PlanRejected(answer)
        return {}

    async def work_node(state: MissionState) -> MissionState:
        """Run the plan, a wave at a time.

        A wave is the tasks whose dependencies are all satisfied. A plan that
        declares none comes back as one task per wave — exactly the sequential
        behaviour this had before — so nothing runs alongside anything else
        unless the leader said it could.

        What is deliberately *not* shared between tasks in a wave: nothing is.
        Each is its own conversation, as it always was. Two tasks running
        together can still collide in the workspace if they write the same file,
        which is precisely the case the leader is asked to declare as a
        dependency.
        """
        tasks = state.get("tasks") or []
        results = list(state.get("results") or [])
        #: index -> result, so the order the leader wrote survives the order
        #: they happen to finish in. The summary reads the plan, not the race.
        landed: dict[int, dict[str, Any]] = {}
        finished = 0

        async def run_one(index: int, task: dict[str, Any], queued_after: int) -> None:
            nonlocal finished

            for warning in budget.record_superstep():
                await emit(warning)
            budget.check()

            member = snapshot.by_seat(task["assignee_seat"])
            if member is None:
                # The planner validates seats, so this is a corrupted plan
                # rather than a model mistake. Recorded, not silently skipped.
                await emit(
                    _draft(
                        "error",
                        {
                            "code": "task_unassigned",
                            "message": f"task {task['id']} names seat "
                            f"{task['assignee_seat']}, which nobody occupies",
                            "recoverable": True,
                        },
                    )
                )
                return

            await emit(
                _draft(
                    "mission.progress",
                    {
                        "taskId": task["id"],
                        "label": task["title"],
                        "state": "running",
                        "done": finished,
                        "total": len(tasks),
                    },
                )
            )

            provider, caps = provider_for(member)
            box = tools_for(member) if tools_for else None
            # An agent that can pull in text written by someone else is told, in
            # its own system prompt, that such text is data (§16.6). Added here
            # rather than saved into the agent's prompt: it depends on which
            # tools this mission gave it, and a stored copy would drift.
            system = member.system_prompt
            if box and (rule := box.system_addendum()):
                system = "\n\n".join([system, rule]).strip()

            # Anything a teammate left for this member, delivered now rather
            # than merely logged: splitting a researcher from a writer (§16.6)
            # is only advice worth taking if the two can actually hand work
            # over.
            instruction = task["instruction"]
            # **What earlier tasks failed to produce.**
            #
            # A worker is handed its own instruction and nothing else, so a
            # task running after a failure had no way to know one had happened.
            # On a real run that meant QA agents spending a turn each on a site
            # that was never built: both build tasks failed, the plan carried
            # on regardless, and the run reached 2,159,380 tokens with `docs/`
            # as the only thing on disk.
            #
            # The fact, in one line, and the agent decides what to do with it —
            # which is already how they behave when they can tell. The QA agent
            # that *could* see the empty workspace opened its report with
            # "neither file exists, the pass is unmeasurable" rather than
            # inventing a result.
            #
            # Deliberately not a skip. `depends_on` is absent on most plans,
            # where it means "after the one before it", so cancelling every
            # later task on a failure would throw away work that has nothing to
            # do with it.
            if lost := [
                r["task"]["title"]
                for _index, r in sorted(landed.items())
                if not r.get("ok", True)
            ]:
                instruction = "\n\n".join(
                    [
                        "Before you start, from earlier in this plan: "
                        + "; ".join(f"{t!r} failed and produced nothing" for t in lost)
                        + ". Do not assume anything those tasks were meant to"
                        " produce exists — check, and say plainly if what you"
                        " need is missing.",
                        "---",
                        instruction,
                    ]
                )
            # The user's own files, in front of the task. Before the mailbox
            # block below, because "here is what you were given" reads ahead of
            # "here is what a teammate said about it".
            if documents:
                instruction = "\n\n".join([documents, "---", instruction])
            mailbox = box.context.extras.get("mailbox") if box else None
            if mailbox is not None and (waiting := mailbox.collect(member.agent_id)):
                delivered = "\n\n".join(
                    "\n".join([f"{mailbox.name_of(sender)} says:", content])
                    for sender, content in waiting
                )
                instruction = "\n\n".join([delivered, "---", instruction])

            request = ChatRequest(
                model=member.model or "",
                messages=[Message("user", instruction, images=images)],
                system=system,
                max_tokens=MAX_TOKENS_PER_TASK,
                sampling=member.sampling,
            )

            answer = ""
            #: The reply hit max_tokens and stops mid-sentence.
            cut_off = False
            #: A tool call hit max_tokens mid-arguments and was **not run**.
            lost_a_call = False
            #: A file tool succeeded, so something is on disk whatever else
            #: happened to the turn. Correlated start-to-end by `callId`, the
            #: same way the runner watches for artifacts -- `agent.tool.end`
            #: carries the outcome and only the start carries the tool name.
            wrote = False
            writing: set[str] = set()
            async for item in run_agent_turn(
                provider=provider,
                caps=caps,
                request=request,
                mission_id=mission_id,
                agent_id=member.agent_id,
                budget=budget,
                tools=box,
                spend_ceiling=task_allowance(budget.remaining_tokens, queued_after),
            ):
                await emit(item)
                if is_ephemeral(item):
                    continue
                kind, payload = item["type"], item["payload"]
                if kind == "agent.message":
                    answer = payload["content"]
                elif kind == "agent.tool.start":
                    if payload.get("tool") in FILE_TOOLS:
                        writing.add(str(payload.get("callId") or ""))
                elif kind == "agent.tool.end":
                    if str(payload.get("callId") or "") in writing and payload.get("ok"):
                        wrote = True
                elif kind == "error":
                    code = payload["code"]
                    cut_off = cut_off or code == "output_truncated"
                    lost_a_call = lost_a_call or code == "tool_call_truncated"

            # A task that produced nothing is not done, whatever the loop
            # counter says. A live run reported `done 1/2` for a turn that was
            # cut off before it emitted a word, and the next teammate correctly
            # replied that there was nothing to check -- the progress line was
            # the only part of the record that was untrue (section 1).
            #
            # **And a turn that was cut off did not finish either.** That is the
            # same rule, one step further, and it took a second live run to see
            # it. The designer had no `write_file`, so its plan was to hand the
            # spec to the developer through `send_message` -- and that call was
            # truncated mid-arguments and never ran, its own reply was
            # truncated too, and both facts were on the log as `error` events
            # one and three events before this task was recorded **done**.
            #
            # It passed because `answer.strip()` was not empty: the model had
            # written 800 characters of "here is what I am about to hand over"
            # before the cap hit. Non-empty text means the model said
            # something, never that the work is finished.
            #
            # What that cost is the reason this is worth the care. The next two
            # agents were told the spec existed, spent four minutes of a
            # fifteen-minute budget running `find /` for it -- two of those
            # calls hit the shell timeout -- and the run parked on a question
            # to the user asking where the files were.
            #
            # A written file still counts. An agent that saved its work and
            # then ran out of room mid-summary has done the task; the
            # deliverable is on disk and `artifact.created` says so. Only a
            # turn that was cut off with nothing written is unfinished.
            # **And a task that was asked for a file, and wrote none, has not
            # done the task — whatever it said about itself.** That is the same
            # rule a third time, and it took a real run to see: a five-task
            # round recorded every task `done`, the run recorded `completed`,
            # and the folder held no `index.html` and no `css/style.css`. The
            # two build tasks had replied with prose describing the file they
            # were about to write and never called a tool.
            #
            # Nothing downstream could recover from that. `ending_for` corrects
            # a run to `failed` when a *task* failed, so with every task
            # claiming success it had nothing to correct — the task states lied
            # first. The QA agents were honest ("neither file exists in the
            # workspace"), the leader's own summary was honest ("nothing was
            # built"), and the row said `completed` over both.
            #
            # `_WRITES_A_FILE` is the planner's own test for "this task writes
            # a file", already used to check the assignee holds `write_file`.
            # Asking it a second question here costs one regex and is the same
            # answer, so the two cannot disagree about which tasks owe a file.
            owed_a_file = bool(_WRITES_A_FILE.search(str(task.get("instruction") or "")))
            produced = (
                bool(answer.strip())
                and (wrote or not (cut_off or lost_a_call))
                and (wrote or not owed_a_file)
            )
            landed[index] = {
                "task": task,
                "agent_id": member.agent_id,
                "answer": answer,
                "ok": produced,
            }
            finished += 1
            await emit(
                _draft(
                    "mission.progress",
                    {
                        "taskId": task["id"],
                        "label": task["title"],
                        "state": "done" if produced else "failed",
                        "done": finished,
                        "total": len(tasks),
                    },
                )
            )
            if not produced:
                await emit(
                    _draft(
                        "error",
                        {
                            "agentId": member.agent_id,
                            "code": "task_produced_nothing",
                            # Which of the three it was, because they need
                            # different answers: an empty reply is a model that
                            # spent its room reasoning, a cut-off reply is a
                            # task too big for one turn, and a lost tool call
                            # is an action that never happened at all.
                            "message": (
                                f"{member.name} returned no usable answer for "
                                f"{task['title']!r}"
                                + (
                                    " (the task asks for a file and none was "
                                    "written; the reply described the work "
                                    "instead of doing it)"
                                    if owed_a_file and not wrote and answer.strip()
                                    else ""
                                )
                                + (
                                    " (a tool call was cut off at max_tokens "
                                    "and never ran)"
                                    if lost_a_call
                                    else " (cut off at max_tokens)"
                                    if cut_off
                                    else ""
                                )
                            ),
                            "recoverable": True,
                        },
                    )
                )

        waves = plan_waves(tasks)
        for at, wave in enumerate(waves):
            # Stop *starting* work when the working share is gone, rather than
            # being cut off mid-task by `BudgetExceeded` on the next call.
            #
            # The difference is the whole point. A hard stop leaves files
            # nobody described and a record whose only account of itself is a
            # number; stopping here lets whatever is already running finish and
            # keeps enough in hand for the leader to say what was done, what
            # was not, and what a next round should pick up.
            #
            # Tasks never started keep their `pending` state, and
            # `unfinished_note` already names them on the ending.
            if (spent := budget.work_exhausted()) is not None:
                budget.stopped_early = spent
                kind, used, limit = spent
                await emit(
                    _draft(
                        "error",
                        {
                            "agentId": leader.agent_id,
                            "code": "work_stopped_for_summary",
                            "message": (
                                f"the {kind} left ({used:.0f} of {limit:.0f}) is "
                                "being kept for the summary, so no further tasks "
                                "were started"
                            ),
                            "recoverable": True,
                        },
                    )
                )
                break
            # How many tasks are still queued behind this wave. Their share is
            # what this wave may not spend.
            queued_after = sum(len(w) for w in waves[at + 1 :])
            if len(wave) == 1:
                # The common case, and it stays a plain await: one task in
                # flight should not pay for a task group or read like one.
                await run_one(wave[0], tasks[wave[0]], queued_after)
                continue
            # `gather` rather than a queue: a wave is small, and the cap is the
            # thing that keeps one mission from becoming a burst. A budget
            # exception from any of them still ends the mission — the others are
            # cancelled with the node.
            for chunk in [
                wave[at : at + MAX_PARALLEL] for at in range(0, len(wave), MAX_PARALLEL)
            ]:
                await asyncio.gather(
                    *(run_one(i, tasks[i], queued_after) for i in chunk)
                )

        results.extend(landed[index] for index in sorted(landed))
        return {"results": results}

    async def summarise_node(state: MissionState) -> MissionState:
        # What was held back is for exactly this turn. Released before the
        # superstep is counted, or a run stopped on the superstep reserve would
        # be refused the one step the reserve exists for.
        budget.release_reserve()
        for warning in budget.record_superstep():
            await emit(warning)
        budget.check()

        results = state.get("results") or []
        # A task that produced nothing is reported as such rather than left as a
        # blank the leader has to guess at -- and guessing is how a summary ends
        # up describing work that never happened.
        transcript = "\n\n".join(
            f"[{r['task']['title']}]\n"
            + (r["answer"] if r.get("ok", True) else "(no answer was produced)")
            for r in results
        )
        provider, caps = provider_for(leader)
        request = ChatRequest(
            model=leader.model or "",
            messages=[
                Message(
                    "user",
                    f"Goal: {state['goal']}\n\nYour team reported:\n\n{transcript}\n\n"
                    + (
                        # A run that was cut short needs a different answer
                        # from one that finished: the reader's next question is
                        # "what do I still not have", and the leader is the
                        # only one able to say it in the goal's own terms.
                        "This run stopped early — it reached one of its limits, "
                        "and the tasks above are all it managed. Write the "
                        "handover: what is finished and where it is, what is "
                        "missing, and what the next round should do first. Do "
                        "not claim anything is done that is not."
                        if budget.stopped_early is not None
                        else "Write the final answer for the user. Do not "
                        "describe the process."
                    ),
                    # The summariser gets the pictures too. Without them a run
                    # that answered correctly was *recorded* as having failed:
                    # the worker read the image and reported
                    # "purple, yellow, teal, orange", and the leader — asked to
                    # write the final answer for a goal that says "look at the
                    # image" — found no image, said so, and that sentence became
                    # `mission.ended`'s summary and final-answer.md.
                    #
                    # A summary is the run's own account of itself, so a
                    # summariser that cannot see what the run was about writes
                    # the one thing §1 forbids: a record that contradicts what
                    # happened.
                    images=images,
                )
            ],
            system=leader.system_prompt,
            max_tokens=MAX_TOKENS_PER_TASK,
            sampling=leader.sampling,
        )

        summary = ""
        async for item in run_agent_turn(
            provider=provider,
            caps=caps,
            request=request,
            mission_id=mission_id,
            agent_id=leader.agent_id,
            budget=budget,
            ):
            await emit(item)
            if not is_ephemeral(item) and item["type"] == "agent.message":
                summary = item["payload"]["content"]

        return {"summary": summary}

    builder = StateGraph(MissionState)
    builder.add_node("plan", plan_node)
    builder.add_node("approve", approve_node)
    builder.add_node("work", work_node)
    builder.add_node("summarise", summarise_node)
    builder.add_edge(START, "plan")
    builder.add_edge("plan", "approve")
    builder.add_edge("approve", "work")
    builder.add_edge("work", "summarise")
    builder.add_edge("summarise", END)
    return builder.compile(checkpointer=checkpointer)


__all__ = [
    "run_team_mission",
    "MissionState",
    "Paused",
    "BudgetExceeded",
    "PlanningFailed",
    "PlanRejected",
]
