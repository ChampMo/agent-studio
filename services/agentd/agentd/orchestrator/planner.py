"""The leader turns a goal into tasks (PROJECT_BRIEF.md §7).

Same discipline as `profile_gen`: validate and retry, always. The plan decides
who does what for the rest of the mission, so a plan that names a seat nobody
occupies would send a task nowhere and the mission would end with work missing
and no explanation.

The retry feeds the correction back rather than starting over, and a plan that
cannot be produced after three attempts fails the mission out loud rather than
being replaced with something invented.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from ..agents.profile_gen import extract_json
from ..providers.base import (
    Capabilities,
    ChatRequest,
    DoneChunk,
    LLMProvider,
    Message,
    TextChunk,
    Usage,
    was_truncated,
)
from ..teams.snapshot import RosterSnapshot

MAX_TOKENS = 4096
MAX_ATTEMPTS = 3
MAX_TASKS = 12


class Task(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=120)
    assignee_seat: int = Field(ge=0)
    instruction: str = Field(min_length=1, max_length=2000)


class Plan(BaseModel):
    tasks: list[Task] = Field(min_length=1, max_length=MAX_TASKS)


class PlanningFailed(RuntimeError):
    def __init__(self, attempts: list[str], usage: Usage) -> None:
        super().__init__(attempts[-1] if attempts else "no attempts were made")
        self.attempts = attempts
        self.usage = usage


@dataclass
class PlanResult:
    plan: Plan
    usage: Usage = field(default_factory=Usage)
    attempts: int = 1
    recovered_from: list[str] = field(default_factory=list)


SYSTEM = """You are {name}, the leader of a small team. Break the goal into tasks
and assign each one to a teammate by seat number.

Return ONE JSON object and nothing else:
{{"tasks": [{{"id": "t1", "title": "...", "assignee_seat": 0, "instruction": "..."}}]}}

`instruction` is what that teammate will be told, on its own, with no other
context. Write it so it stands alone.

Your team:
{roster}

Rules:
- assignee_seat must be one of the seats listed above.
- One task per distinct piece of work. Do not pad. At most {max_tasks}.
- Order matters: tasks run in the order you list them.
"""


def _roster_text(snapshot: RosterSnapshot) -> str:
    return "\n".join(
        f"  seat {m.seat_index}: {m.name} — {m.title or m.role or 'teammate'}"
        + (" (you, the leader)" if m.is_leader else "")
        for m in snapshot.members
    )


def _check_seats(plan: Plan, snapshot: RosterSnapshot) -> str | None:
    """A seat nobody occupies means a task with nowhere to go."""
    seats = {m.seat_index for m in snapshot.members}
    bad = sorted({t.assignee_seat for t in plan.tasks} - seats)
    if not bad:
        return None
    return (
        f"assignee_seat {bad} does not exist on this team; "
        f"valid seats are {sorted(seats)}"
    )


async def make_plan(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    snapshot: RosterSnapshot,
    goal: str,
    max_attempts: int = MAX_ATTEMPTS,
) -> PlanResult:
    leader = snapshot.leader
    system = SYSTEM.format(
        name=leader.name if leader else "the leader",
        roster=_roster_text(snapshot),
        max_tasks=MAX_TASKS,
    )
    messages = [Message("user", f"Goal: {goal}")]
    total = Usage()
    failures: list[str] = []

    for attempt in range(1, max_attempts + 1):
        text, usage, stop_reason = await _ask(provider, caps, model, system, messages)
        total = Usage(
            input_tokens=total.input_tokens + usage.input_tokens,
            output_tokens=total.output_tokens + usage.output_tokens,
            cache_read_tokens=total.cache_read_tokens + usage.cache_read_tokens,
            cache_write_tokens=total.cache_write_tokens + usage.cache_write_tokens,
        )

        if was_truncated(stop_reason):
            problem = (
                "the plan was cut off at max_tokens before the JSON closed; "
                "return fewer, shorter tasks"
            )
        else:
            try:
                payload = json.loads(extract_json(text))
            except json.JSONDecodeError as exc:
                problem = f"the reply was not valid JSON ({exc})"
            else:
                try:
                    plan = Plan.model_validate(payload)
                except ValidationError as exc:
                    problem = "; ".join(
                        f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}"
                        for e in exc.errors()
                    )
                else:
                    seat_problem = _check_seats(plan, snapshot)
                    if seat_problem is None:
                        return PlanResult(plan, total, attempt, failures)
                    problem = seat_problem

        failures.append(problem)
        if attempt < max_attempts:
            messages = messages + [
                Message("assistant", text[:2000]),
                Message(
                    "user",
                    f"That plan was rejected: {problem}. Return corrected JSON only.",
                ),
            ]

    raise PlanningFailed(failures, total)


async def _ask(
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    system: str,
    messages: list[Message],
) -> tuple[str, Usage, str | None]:
    request = ChatRequest(
        model=model,
        messages=messages,
        system=system,
        max_tokens=MAX_TOKENS,
        response_schema=Plan.model_json_schema(),
    )
    parts: list[str] = []
    usage, stop_reason = Usage(), None
    async for chunk in provider.stream(request, caps):
        if isinstance(chunk, TextChunk):
            parts.append(chunk.text)
        elif isinstance(chunk, DoneChunk):
            usage, stop_reason = chunk.usage, chunk.stop_reason
    return "".join(parts), usage, stop_reason
