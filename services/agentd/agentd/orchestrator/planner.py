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
import re
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from ..agents.profile_gen import extract_json
from ..tools.registry import FILE_TOOLS
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

#: A reasoning model spends heavily before its first visible character, and a
#: plan cut off mid-JSON costs a whole retry. Room is cheaper than the retry.
MAX_TOKENS = 8192

#: How much more room each retry gets after being cut off.
#:
#: A five-agent team given a detailed brief failed all three attempts with
#: *the plan was cut off before the JSON closed* and never started. The
#: correction cannot help: the tokens went on reasoning before the first
#: visible character, so telling the model to write more briefly changes
#: nothing it can act on — the same wall `MAX_TOKENS_PER_TASK` hit twice, where
#: raising the cap once did not fix it either.
#:
#: So the room grows only where it was actually needed. A plan that fits first
#: time still costs 8,192, and a brief that genuinely needs more gets it instead
#: of failing the mission.
TOKENS_PER_RETRY = 8192
MAX_ATTEMPTS = 3
MAX_TASKS = 12

#: The longest a single task instruction may be.
#:
#: **A floor, not a preference.** An instruction that a round already ran is
#: handed straight back when a stopped round is picked up again, so a ceiling
#: below what the last plan stored makes the retry button impossible rather
#: than merely tight. The longest on the run this was measured against is
#: 1,819 characters, which leaves 181 to re-emit it in.
#:
#: Stated to the model as well as enforced here. It reaches a schema-capable
#: endpoint inside `Plan.model_json_schema()`, and is dropped on a
#: `json_object` endpoint — which is where this failed: six of the first
#: plan's seven instructions were over a number the model had never been
#: given.
MAX_INSTRUCTION_CHARS = 2000


class Task(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=120)
    assignee_seat: int = Field(ge=0)
    instruction: str = Field(min_length=1, max_length=MAX_INSTRUCTION_CHARS)
    #: Task ids that must finish first. **Absent and empty are different.**
    #:
    #: `None` — the field was not written — means "after the one before it",
    #: which is what every plan did before this field existed and is always
    #: safe. `[]` is the leader saying the task needs nothing from anyone, and
    #: is what lets it start early.
    #:
    #: So a model that ignores the field produces exactly the old behaviour,
    #: and parallelism only happens where someone said so.
    depends_on: list[str] | None = None

    #: Tool ids this task cannot be done without, so it can be routed to
    #: somebody who holds them.
    #:
    #: Unlike `depends_on`, absent and empty mean the same thing — nothing
    #: declared, nothing checked — because there is no third state to
    #: distinguish: a task that needs no particular tool and a task whose
    #: needs were not stated both route the same way.
    #:
    #: This exists because the alternative is reading prose. `_WRITES_A_FILE`
    #: does that for the one case worth guessing at and stays as the backstop
    #: for a model that ignores this field, but it cannot be extended: a
    #: release check failed on a task titled "Shell-verify DESIGN.md
    #: contents", handed to the one teammate with no `bash` while another
    #: carried it, and no regex over that sentence tells you it needs a shell
    #: rather than a reader. This project has twice paid for loose matching
    #: — `is_secret_key` eating `inputTokens`, a shell splitter flagging
    #: `.git` inside a path — so the answer is to be told rather than to
    #: guess harder. Same move as `depends_on`: the plan is the only thing
    #: that knows, so the plan says.
    needs_tools: list[str] | None = None


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
    #: Plans the model got wrong and was asked to redo. A fact about the model.
    recovered_from: list[str] = field(default_factory=list)
    #: Assignments this side moved without asking, because there was exactly
    #: one teammate who could do the work. A different fact from the above —
    #: nothing was rejected and no attempt was spent — so it is carried
    #: separately and said in its own words on the log (§1).
    repaired: list[str] = field(default_factory=list)


SYSTEM = """You are {name}, the leader of a small team. You do not do the work
yourself: you break the goal into tasks, hand each one to a teammate, and write
the final answer once they report back.

Return ONE JSON object and nothing else:
{{"tasks": [{{"id": "t1", "title": "...", "assignee_seat": 0, "instruction": "..."}}]}}

`instruction` is what that teammate will be told, on its own, with no other
context and no memory of this plan. Write it so it stands alone.

Tasks that do not need each other run at the same time, which is faster. Say so
with `"depends_on"`:

  - leave `depends_on` out    -> runs after the task before it. Always safe.
  - `"depends_on": []`        -> can start immediately, in parallel.
  - `"depends_on": ["t1"]`    -> waits for t1.

Declare a dependency whenever a task reads what another task wrote, checks
another task's work, or edits the same file. When you are not sure, leave the
field out.

Your team:
{roster}

Rules:
- assignee_seat must be one of the teammate seats listed above.{leader_note}
- Give every teammate at least one task. You have them for a reason.
- One task per distinct piece of work. Do not pad. At most {max_tasks}.
- `instruction` must be at most {max_chars} characters. Aim well under it.
- If the message hands you an instruction from an earlier round, reuse its
  wording as it stands. Do not restate the goal around it — it was written to
  stand alone already, and rewriting it is what pushes it over the limit.
- Give a task to someone who can do it, and say what it needs with
  `"needs_tools"`, using the ids listed beside each teammate above:
  `{{"needs_tools": ["bash"]}}` for a task that runs a command,
  `["write_file"]` for one that saves a file, `["web_search", "web_fetch"]`
  for one that has to look something up. Leave it out when the task needs
  nothing in particular. Teammates cannot borrow each other's tools, and a
  task sent to someone without them gets nothing done.
- List them in the order they make sense; `depends_on` decides what waits.
"""


def _problem_from(exc: ValidationError, payload: Any) -> str:
    """A rejection the model can act on, built from a Pydantic error.

    The raw join reads `tasks.0.instruction: String should have at most 2000
    characters`: an array index, where the plan, the log and the prompt all
    speak in task ids; no statement of how long the string actually was, so
    "shorter" has no size; and nothing to say the other tasks were accepted.

    A model answered that three times on a real run by writing the whole plan
    again from scratch and overshooting again, and the round died having done
    nothing. Naming the task and the overshoot costs one function and turns
    "try again" into an edit.

    The offending text itself is deliberately **not** quoted back — the model
    has its own reply above this message, whole, and repeating a 2,000
    character instruction inside the correction is paying for it twice.
    """
    tasks = payload.get("tasks") if isinstance(payload, dict) else None
    parts: list[str] = []
    for err in exc.errors():
        loc = err.get("loc", ())
        named = ".".join(str(p) for p in loc)
        if err.get("type") != "string_too_long" or len(loc) != 3 or loc[0] != "tasks":
            parts.append(f"{named}: {err['msg']}")
            continue
        index, field = loc[1], loc[2]
        task = tasks[index] if isinstance(tasks, list) and index < len(tasks) else {}
        who = task.get("id") if isinstance(task, dict) else None
        title = task.get("title") if isinstance(task, dict) else None
        limit = (err.get("ctx") or {}).get("max_length")
        actual = len(err["input"]) if isinstance(err.get("input"), str) else None
        where = f"task {who}" if who else f"task {index + 1}"
        if title:
            where += f" ({title})"
        over = f" — it is {actual} characters and the limit is {limit}" if actual else ""
        parts.append(f"the {field} for {where} is too long{over}")
    joined = "; ".join(parts)
    return (
        f"{joined}. Shorten only what is named here and send every other task "
        "back exactly as you wrote it above."
    )


def _roster_text(snapshot: RosterSnapshot) -> str:
    """The team as the leader sees it — including what each member can do.

    The tools were missing, and a plan is an assignment: a leader that cannot
    see who holds `write_file` will hand "create INDEX.md" to whoever sounds
    right. Seen on a real run — the task went to a designer with read-only
    tools, who spent five turns trying to hand it on and never wrote the file.

    Listed plainly rather than described, because the ids are what the tools are
    actually called everywhere else the person will meet them.
    """
    return "\n".join(
        f"  seat {m.seat_index}: {m.name} — {m.title or m.role or 'teammate'}"
        + (f" — can: {', '.join(m.tools)}" if m.tools else " — no tools")
        + (" (you — you plan and summarise, you do not take tasks)" if m.is_leader else "")
        for m in snapshot.members
    )


def _assignable(snapshot: RosterSnapshot) -> set[int]:
    """Seats a task may go to.

    The leader supervises (the brief makes the leader the graph's supervisor),
    so on a team that has workers the leader is excluded. Without this the plan
    can assign everything to itself and the other members never run — which is
    what happened on the first live three-agent run: one task, seat 0, and two
    teammates that did nothing. A solo team has nobody else, so there the leader
    takes its own work.
    """
    workers = {m.seat_index for m in snapshot.workers}
    return workers or {m.seat_index for m in snapshot.members}


def _check_deps(plan: Plan) -> str | None:
    """Dependencies that name something real, and that finish.

    Three ways a plan can be unrunnable, and each is a correction the leader can
    act on rather than a crash: a dependency on a task that does not exist, a
    task waiting on itself, and a cycle. Checked here for the same reason seats
    are — a plan is what decides the rest of the mission, and one that cannot be
    scheduled would fail somewhere far from the cause.
    """
    ids = [task.id for task in plan.tasks]
    known = set(ids)
    if len(known) != len(ids):
        repeated = sorted({i for i in ids if ids.count(i) > 1})
        return f"two tasks share the id {', '.join(repeated)}; ids must be unique"

    for task in plan.tasks:
        for needed in task.depends_on or []:
            if needed == task.id:
                return f"task {task.id} waits for itself"
            if needed not in known:
                return (
                    f"task {task.id} depends on {needed!r}, which is not a task "
                    f"in this plan; the ids are: {', '.join(ids)}"
                )

    # Kahn's algorithm, only to find out whether anything is left over.
    waiting = {
        task.id: set(task.depends_on or []) if task.depends_on is not None else set()
        for task in plan.tasks
    }
    # An absent `depends_on` means "after the one before it", so the implicit
    # edge has to be part of the check or a plan could look acyclic and deadlock.
    for index, task in enumerate(plan.tasks):
        if task.depends_on is None and index > 0:
            waiting[task.id].add(plan.tasks[index - 1].id)

    done: set[str] = set()
    while True:
        ready = [tid for tid, needs in waiting.items() if tid not in done and needs <= done]
        if not ready:
            break
        done.update(ready)
    stuck = sorted(set(waiting) - done)
    if stuck:
        return f"these tasks wait on each other and none can start: {', '.join(stuck)}"
    return None


def _check_seats(plan: Plan, snapshot: RosterSnapshot) -> str | None:
    """A task assigned to a seat that cannot take one would simply vanish."""
    seats = _assignable(snapshot)
    bad = sorted({t.assignee_seat for t in plan.tasks} - seats)
    if not bad:
        return None
    leader = snapshot.leader
    hint = (
        f" Seat {leader.seat_index} is you: you summarise at the end instead."
        if leader and leader.seat_index in bad
        else ""
    )
    return (
        f"assignee_seat {bad} cannot take a task; "
        f"assignable seats are {sorted(seats)}.{hint}"
    )

#: A verb that means "put something on disk", then a file name, close together
#: and on one line.
#:
#: Narrow on purpose, because this project has paid twice for loose matching:
#: `is_secret_key` matched substrings and redacted `inputTokens`, destroying
#: real numbers in an append-only table, and a shell splitter that looked for
#: `\bgit\b` anywhere flagged `find . -not -path '*/.git/*'`. So both halves
#: have to be present: a writing verb *and* something shaped like a file name
#: within a few words of it. "Read BA_user_journey.md and report what it says"
#: has the file and no verb, and is left alone.
_WRITES_A_FILE = re.compile(
    r"\b(?:write|create|produce|save|output|generate|implement|build"
    r"|add|update|edit|modify)\b"
    r"[^\n]{0,40}?"
    r"\b[\w.-]+\.(?:md|markdown|html?|css|jsx?|tsx?|json|ya?ml|toml|py|txt|csv|sh)\b",
    re.IGNORECASE,
)


def _needed_by(task: Task) -> list[set[str]]:
    """What a seat must hold to be given this task, as any-of groups.

    A seat qualifies when its toolbox meets **every** group. One group per
    declared tool, because each is separately required; one group of
    `FILE_TOOLS` when the instruction reads like it writes a file, because
    either of them will do.

    **The regex is a fallback, not an addition.** A plan that declared its
    needs has already answered the question, and guessing on top of the
    answer is how the first version of this got it wrong: a review task
    correctly declaring `read_file`, whose instruction said *"Do not edit
    either file"*, had a write requirement added from the word `edit` inside
    the prohibition — and was moved to the one teammate who could write, for
    a job that must not write. The prose is consulted only when nobody said.
    """
    declared = list(dict.fromkeys(t for t in (task.needs_tools or []) if t))
    if declared:
        return [{tool} for tool in declared]
    if _WRITES_A_FILE.search(task.instruction or ""):
        return [set(FILE_TOOLS)]
    return []


def _can_do(tools: set[str], groups: list[set[str]]) -> bool:
    return all(tools & g for g in groups)


def owes_a_file(task: Task | dict[str, Any]) -> bool:
    """Whether finishing this task means a file exists afterwards.

    Two places ask: routing, to find an assignee who can write, and the
    runtime, to refuse `done` to a turn that described a file instead of
    writing one. One function, so they cannot disagree — and it takes a
    plain dict as well, because by the time the graph asks, the task is one.
    """
    if isinstance(task, dict):
        declared = [t for t in (task.get("needs_tools") or []) if t]
        instruction = str(task.get("instruction") or "")
    else:
        declared = [t for t in (task.needs_tools or []) if t]
        instruction = task.instruction or ""
    if declared:
        return bool(set(declared) & set(FILE_TOOLS))
    return bool(_WRITES_A_FILE.search(instruction))


def _candidates(snapshot: RosterSnapshot, groups: list[set[str]]) -> set[int]:
    """Seats that can be given a task *and* hold everything it needs."""
    assignable = _assignable(snapshot)
    return {
        m.seat_index
        for m in snapshot.members
        if m.seat_index in assignable and _can_do(set(m.tools or ()), groups)
    }


def _short(groups: list[set[str]]) -> str:
    """The requirement, in the ids the roster uses."""
    return " and ".join(" or ".join(sorted(g)) for g in groups)


def _unknown_tools(plan: Plan, snapshot: RosterSnapshot) -> str | None:
    """A declared tool has to be a real one, or it routes nothing.

    Silently dropping a name the registry does not know would turn the whole
    check off for that task without anybody being told, which is the quiet
    half of the failure this field exists to fix. Same treatment the avatar
    catalogue and the agent generator's tool list already get: name what was
    wrong, list what is real, let the model correct it.
    """
    from ..tools.registry import all_specs

    real = {spec.id for spec in all_specs()}
    held = sorted({t for m in snapshot.members for t in (m.tools or ())})
    for task in plan.tasks:
        for tool in task.needs_tools or []:
            if tool in real:
                continue
            return (
                f"task {task.id} lists {tool!r} in needs_tools, which is not a "
                f"tool. Use the ids from the roster above — this team holds "
                f"{', '.join(held) if held else 'none'} — or leave needs_tools "
                f"out when the task needs nothing in particular."
            )
    return None


def _repair_tools(plan: Plan, snapshot: RosterSnapshot) -> list[str]:
    """Move a writing task to the only teammate who can write, and say so.

    The correction below is well phrased and was still the wrong response to
    this situation. A real run died with
    `planning_failed: task t5 writes a file ... Give it to one of seats [1]` —
    **seats [1]**, one seat. There was nothing to decide. The app knew the only
    legal answer, spent three attempts asking a model to guess it, and then
    threw the run away in front of somebody who had done nothing but pick a
    team and describe a job.

    So: exactly one candidate is not a choice, and this reassigns it. Two or
    more is a choice, and that still goes back to the model, because picking
    between people who can both do the work is the leader's job and not ours.

    The move is returned as a sentence rather than done quietly. The plan on
    the timeline is the plan that will run either way, so it is not untrue
    without this — but "Sorrel was handed a writing task and cannot write" is
    worth knowing about your own team, and the person who composed it is the
    only one who can fix that.

    **Decided per task, not per team.** The first version asked whether the
    team had exactly one writer and repaired everything if so, which only
    ever worked because there was one requirement. With a task naming its own
    tools, two tasks in one plan can each have a single — and different —
    legal assignee.
    """
    by_seat = {m.seat_index: m for m in snapshot.members}
    moved: list[str] = []

    for task in plan.tasks:
        groups = _needed_by(task)
        if not groups:
            continue
        was = by_seat.get(task.assignee_seat)
        if was is not None and _can_do(set(was.tools or ()), groups):
            continue
        able = _candidates(snapshot, groups)
        if len(able) != 1:
            continue
        only = next(iter(able))
        now = by_seat.get(only)
        task.assignee_seat = only
        moved.append(
            f"{task.id} needs {_short(groups)} and went to "
            f"{was.name if was else f'seat {task.assignee_seat}'}, who does not "
            f"carry that; it was given to {now.name if now else f'seat {only}'}, "
            f"the only teammate on this team who does"
        )
    return moved


def _check_tools(plan: Plan, snapshot: RosterSnapshot) -> str | None:
    """A task that writes a file has to go to somebody who can write files.

    The prompt already asks for this, and `_roster_text` shows the leader every
    member's tools so it can. Both landed after a run where "create INDEX.md"
    went to a designer holding only read tools, who spent five turns trying to
    hand it on and never wrote the file.

    **It happened again, to the same designer.** Task 2 of a five-agent run was
    "write UX_design_spec.md"; the UX/UI Designer carries `ask_user, glob,
    grep, list_dir, read_file, send_message`. Having no way to save the file,
    it wrote the whole spec into a `send_message` call to the developer -- and
    that call was cut off at max_tokens and never ran. Nothing was written,
    nothing was delivered, and the two agents after it spent four minutes of a
    fifteen-minute budget searching the disk for a file that had never existed.

    So this is a check rather than a sentence in a prompt. The distinction is
    one this project keeps arriving at: a prompt is a request, and the thing
    that makes a rule true is code. It is the same reasoning that put the
    duplicate-name gate in `validator.py` instead of trusting the generator to
    read its instructions.

    **Silent when there is nobody better.** A team whose only members are
    read-only cannot satisfy this correction, and a check that cannot be
    obeyed would burn every attempt and fail the mission outright -- worse than
    the problem. So it fires only when some other assignable seat can actually
    do the work, which is exactly when reassigning is the fix.

    **It is no longer only about writing.** A task declares what it needs,
    so this covers `bash`, the web tools and anything else a team carries.
    The release check that prompted it had a task called "Shell-verify
    DESIGN.md contents" go to the one teammate without a shell while another
    held it: the run did the work, reported that "the workspace exposes no
    shell", and was recorded `failed` — a misassignment reading as a broken
    app.
    """
    by_seat = {m.seat_index: m for m in snapshot.members}
    for task in plan.tasks:
        groups = _needed_by(task)
        if not groups:
            continue
        member = by_seat.get(task.assignee_seat)
        if member is not None and _can_do(set(member.tools or ()), groups):
            continue
        able = _candidates(snapshot, groups)
        # Nobody can: saying so would burn every attempt on an instruction
        # that cannot be followed. Exactly one: repaired above, not argued
        # about. So the correction is for a real choice between people.
        if len(able) < 2:
            continue
        who = member.name if member else f"seat {task.assignee_seat}"
        has = ", ".join(member.tools) if member and member.tools else "no tools"
        return (
            f"task {task.id} needs {_short(groups)} but seat "
            f"{task.assignee_seat} ({who}) cannot do it: it has {has}. "
            f"Give it to one of seats {sorted(able)}. Teammates cannot borrow "
            f"each other's tools."
        )
    return None


async def make_plan(
    *,
    provider: LLMProvider,
    caps: Capabilities,
    model: str,
    snapshot: RosterSnapshot,
    goal: str,
    #: What happened in the rounds before this one, when there were any.
    #:
    #: A continued round used to plan from the new message alone, so "carry on"
    #: was a goal that read, in full, "carry on". The leader could not see the
    #: earlier instruction, what the team had built, or the handover it had
    #: itself written a minute earlier — which was the odd part: the handover
    #: names the files, what is missing and what to do next, and nothing read
    #: it but a person.
    #:
    #: Not the whole log. That is the conversation the workers already re-send
    #: turn by turn, and a plan is made from what was asked and what is left.
    earlier: str = "",
    max_attempts: int = MAX_ATTEMPTS,
) -> PlanResult:
    leader = snapshot.leader
    assignable = _assignable(snapshot)
    system = SYSTEM.format(
        name=leader.name if leader else "the leader",
        roster=_roster_text(snapshot),
        max_tasks=MAX_TASKS,
        max_chars=MAX_INSTRUCTION_CHARS,
        leader_note=(
            f" Do not assign anything to seat {leader.seat_index} — that is you."
            if leader and leader.seat_index not in assignable
            else ""
        ),
    )
    messages = (
        [Message("user", f"Goal: {goal}")]
        if not earlier
        else [
            Message(
                "user",
                f"{earlier}\n\n---\n\nThat is what has happened so far. "
                f"The user now says:\n\n{goal}\n\nPlan only the work that is "
                "still needed. Do not re-do what is already finished, and "
                "do not assume anything is finished that the record above "
                "does not say was."
            )
        ]
    )

    total = Usage()
    failures: list[str] = []
    #: How many attempts so far were cut off rather than wrong.
    truncations = 0

    for attempt in range(1, max_attempts + 1):
        text, usage, stop_reason = await _ask(
            provider,
            caps,
            model,
            system,
            messages,
            # Only truncation earns more room. A plan rejected for naming a bad
            # seat does not need a bigger budget to fix that.
            max_tokens=MAX_TOKENS + TOKENS_PER_RETRY * truncations,
        )
        total = Usage(
            input_tokens=total.input_tokens + usage.input_tokens,
            output_tokens=total.output_tokens + usage.output_tokens,
            cache_read_tokens=total.cache_read_tokens + usage.cache_read_tokens,
            cache_write_tokens=total.cache_write_tokens + usage.cache_write_tokens,
        )

        if was_truncated(stop_reason):
            # Deliberately not "return fewer tasks". That correction taught a
            # model to reply with a single task assigned to itself, and the team
            # never ran. Shorten the wording, never the plan.
            truncations += 1
            problem = (
                "the plan was cut off before the JSON closed; keep every task "
                "but write each instruction much more briefly"
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
                    problem = _problem_from(exc, payload)
                else:
                    # Seats and dependencies first: a task pointed at a seat
                    # nobody occupies cannot be repaired, only rejected.
                    problem = (
                        _check_seats(plan, snapshot)
                        or _check_deps(plan)
                        # Before routing: a tool id nothing recognises cannot
                        # be routed on, and dropping it would turn the check
                        # off without saying so.
                        or _unknown_tools(plan, snapshot)
                    )
                    repaired: list[str] = []
                    if problem is None:
                        repaired = _repair_tools(plan, snapshot)
                        problem = _check_tools(plan, snapshot)
                    if problem is None:
                        return PlanResult(plan, total, attempt, failures, repaired)

        failures.append(problem)
        if attempt < max_attempts:
            messages = messages + [
                # Whole, not clipped. A plan is ~11,000 characters and this
                # used to feed back the first 2,000 of it — one and a half
                # tasks, cut mid-string — so "keep the others as they are"
                # asked the model to preserve text it could no longer see, and
                # it rewrote everything from the goal on every attempt,
                # overshooting the same limit each time. The reply is already
                # bounded by the `max_tokens` we set on it, so echoing it whole
                # is bounded too.
                Message("assistant", text),
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
    *,
    max_tokens: int = MAX_TOKENS,
) -> tuple[str, Usage, str | None]:
    request = ChatRequest(
        model=model,
        messages=messages,
        system=system,
        max_tokens=max_tokens,
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
