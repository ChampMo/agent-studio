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
from collections.abc import AsyncIterator, Callable
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from ..agents.runtime import is_ephemeral, run_agent_turn
from ..core.budget import BudgetExceeded, BudgetTracker
from ..providers.base import Capabilities, ChatRequest, LLMProvider, Message
from ..teams.snapshot import RosterSnapshot, SnapshotMember
from ..tools.execution import ToolBox
from .hitl import APPROVE, Ask, PlanRejected, ask_to_approve, new_request_id, pause
from .planner import PlanningFailed, make_plan

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
MAX_TOKENS_PER_TASK = 8192


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
        result = await make_plan(
            provider=provider,
            caps=caps,
            model=leader.model or "",
            snapshot=snapshot,
            goal=state["goal"],
        )
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

        tasks = [t.model_dump() for t in result.plan.tasks]
        await emit(
            _draft(
                "agent.message",
                {
                    "agentId": leader.agent_id,
                    "messageId": f"plan-{mission_id}",
                    "to": {"kind": "broadcast"},
                    "content": "Plan:\n"
                    + "\n".join(
                        f"{i + 1}. {t['title']} → seat {t['assignee_seat']}"
                        for i, t in enumerate(tasks)
                    ),
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
        tasks = state.get("tasks") or []
        results = list(state.get("results") or [])

        for index, task in enumerate(tasks):
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
                continue

            await emit(
                _draft(
                    "mission.progress",
                    {
                        "taskId": task["id"],
                        "label": task["title"],
                        "state": "running",
                        "done": index,
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
            mailbox = box.context.extras.get("mailbox") if box else None
            if mailbox is not None and (waiting := mailbox.collect(member.agent_id)):
                delivered = "\n\n".join(
                    "\n".join([f"{mailbox.name_of(sender)} says:", content])
                    for sender, content in waiting
                )
                instruction = "\n\n".join([delivered, "---", instruction])

            request = ChatRequest(
                model=member.model or "",
                messages=[Message("user", instruction)],
                system=system,
                max_tokens=MAX_TOKENS_PER_TASK,
                sampling=member.sampling,
            )

            answer = ""
            truncated = False
            async for item in run_agent_turn(
                provider=provider,
                caps=caps,
                request=request,
                mission_id=mission_id,
                agent_id=member.agent_id,
                budget=budget,
                tools=box,
            ):
                await emit(item)
                if is_ephemeral(item):
                    continue
                if item["type"] == "agent.message":
                    answer = item["payload"]["content"]
                elif item["type"] == "error":
                    truncated = truncated or item["payload"]["code"] == "output_truncated"

            # A task that produced nothing is not done, whatever the loop
            # counter says. A live run reported `done 1/2` for a turn that was
            # cut off before it emitted a word, and the next teammate correctly
            # replied that there was nothing to check -- the progress line was
            # the only part of the record that was untrue (section 1).
            produced = bool(answer.strip())
            results.append(
                {
                    "task": task,
                    "agent_id": member.agent_id,
                    "answer": answer,
                    "ok": produced,
                }
            )
            await emit(
                _draft(
                    "mission.progress",
                    {
                        "taskId": task["id"],
                        "label": task["title"],
                        "state": "done" if produced else "failed",
                        "done": index + 1,
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
                            "message": (
                                f"{member.name} returned no usable answer for "
                                f"{task['title']!r}"
                                + (" (cut off at max_tokens)" if truncated else "")
                            ),
                            "recoverable": True,
                        },
                    )
                )

        return {"results": results}

    async def summarise_node(state: MissionState) -> MissionState:
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
                    "Write the final answer for the user. Do not describe the process.",
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
