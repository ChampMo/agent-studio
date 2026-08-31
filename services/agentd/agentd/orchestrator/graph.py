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

from ..agents.runtime import is_ephemeral, run_agent_turn
from ..core.budget import BudgetExceeded, BudgetTracker
from ..providers.base import Capabilities, ChatRequest, LLMProvider, Message
from ..teams.snapshot import RosterSnapshot, SnapshotMember
from .planner import PlanningFailed, make_plan

#: Resolves a snapshot member to a live provider + capabilities. Injected so the
#: graph never learns which vendor anything is (§3.1).
ProviderFor = Callable[[SnapshotMember], "tuple[LLMProvider, Capabilities]"]

MAX_TOKENS_PER_TASK = 4096


class MissionState(TypedDict, total=False):
    goal: str
    tasks: list[dict[str, Any]]
    results: list[dict[str, Any]]
    summary: str


def _draft(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": event_type, "payload": payload}


async def run_team_mission(
    *,
    mission_id: str,
    snapshot: RosterSnapshot,
    goal: str,
    budget: BudgetTracker,
    provider_for: ProviderFor,
) -> AsyncIterator[dict[str, Any]]:
    """Run a team to completion, narrating every step as events."""
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
        emit=emit,
    )

    async def drive() -> None:
        try:
            await graph.ainvoke({"goal": goal, "tasks": [], "results": []})
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
    emit: Callable[[dict[str, Any]], Any],
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
            request = ChatRequest(
                model=member.model or "",
                messages=[Message("user", task["instruction"])],
                system=member.system_prompt,
                max_tokens=MAX_TOKENS_PER_TASK,
                sampling=member.sampling,
            )

            answer = ""
            async for item in run_agent_turn(
                provider=provider,
                caps=caps,
                request=request,
                mission_id=mission_id,
                agent_id=member.agent_id,
                budget=budget,
            ):
                await emit(item)
                if not is_ephemeral(item) and item["type"] == "agent.message":
                    answer = item["payload"]["content"]

            results.append({"task": task, "agent_id": member.agent_id, "answer": answer})
            await emit(
                _draft(
                    "mission.progress",
                    {
                        "taskId": task["id"],
                        "label": task["title"],
                        "state": "done",
                        "done": index + 1,
                        "total": len(tasks),
                    },
                )
            )

        return {"results": results}

    async def summarise_node(state: MissionState) -> MissionState:
        for warning in budget.record_superstep():
            await emit(warning)
        budget.check()

        results = state.get("results") or []
        transcript = "\n\n".join(
            f"[{r['task']['title']}]\n{r['answer']}" for r in results
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
    builder.add_node("work", work_node)
    builder.add_node("summarise", summarise_node)
    builder.add_edge(START, "plan")
    builder.add_edge("plan", "work")
    builder.add_edge("work", "summarise")
    builder.add_edge("summarise", END)
    return builder.compile()


__all__ = ["run_team_mission", "MissionState", "BudgetExceeded", "PlanningFailed"]
