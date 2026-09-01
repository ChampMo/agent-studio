"""Running a tool call: whether to ask, what to record, what to run (§16.1, §16.4).

Three decisions live here, and each is made in exactly one place.

**Whether to ask.** `risk` (registry) against `autonomy` (the agent, frozen into
the snapshot). Not a prompt, not a heuristic — a table. The approval itself
reuses M6's `agent.request` with `kind: "approval"`, because a second mechanism
would be a second thing that has to survive a restart, and the newer one would
be the one without tests (§15 row 30).

**What to record.** `agent.tool.start.input` lands in an append-only table
forever (§9.3), so `redact_fields` replaces the fields a tool declares too big
or too sensitive to keep. `write_file` keeps its path and the size of what it
wrote, which is what a timeline needs in order to say what happened.

**What to run.** Arguments are filtered against the tool's own schema before
they reach the handler. A model that invents an extra field would otherwise
raise `TypeError` deep inside a tool, which reads like a bug in the tool.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from ..providers.base import ToolSpec as ProviderToolSpec
from .base import ToolContext, ToolFailed, ToolResult
from .registry import ToolSpec

#: How many times the model may call tools before the turn is stopped. A model
#: that reads the same file forever is not making progress, and the budget guard
#: only notices once the money is gone.
MAX_TOOL_ROUNDS = 12

APPROVE = "approve"


def needs_approval(*, risk: str, autonomy: str) -> bool:
    """The whole permission model, as a table (§16.4).

    `trusted` is the only value that runs `bash` without asking, and turning it
    on removes the only gate there is — there is no sandbox behind it (§2.7).
    """
    if autonomy == "trusted":
        return False
    if autonomy == "ask_always":
        return True
    # ask_dangerous, and anything unrecognised: an autonomy value this build
    # does not know must not be read as "less asking" (§8).
    return risk == "dangerous" or autonomy not in {"ask_dangerous", "ask_always"}


def redact_input(spec: ToolSpec, arguments: dict[str, Any]) -> dict[str, Any]:
    """The form of the input that is safe to keep forever.

    A redacted field is replaced by its size rather than removed: "wrote 4KB to
    src/main.py" is a true and useful line on a timeline, and an absent field
    would read as though nothing was passed.
    """
    if not spec.redact_fields:
        return dict(arguments)

    out: dict[str, Any] = {}
    for key, value in arguments.items():
        if key not in spec.redact_fields:
            out[key] = value
            continue
        text = value if isinstance(value, str) else str(value)
        out[key] = f"[{len(text.encode('utf-8'))} bytes, not recorded]"
    return out


def clean_arguments(spec: ToolSpec, arguments: dict[str, Any]) -> dict[str, Any]:
    """Keep only the fields the tool declares, so a handler never sees a surprise."""
    allowed = set((spec.input_schema.get("properties") or {}).keys())
    return {k: v for k, v in arguments.items() if k in allowed}


def to_provider_spec(spec: ToolSpec) -> ProviderToolSpec:
    return ProviderToolSpec(
        name=spec.id, description=spec.description, parameters=spec.input_schema
    )


class ApprovalGate(Protocol):
    """Opens a question and waits for the person to answer it.

    Implemented by the mission runner, which owns the routing: the answer
    arrives over REST, on a request id, possibly from a different window.
    """

    def open(self, mission_id: str, request_id: str) -> Any:
        """Register the question *before* it is published, and return an
        awaitable for the answer.

        Registered first on purpose. Publishing and then registering leaves a
        window in which a fast answer arrives for a question nobody is waiting
        on — the same shape of bug as accepting a WebSocket before subscribing
        to the bus."""
        ...


@dataclass
class ToolBox:
    """Everything a turn needs in order to offer and run tools.

    Built by the runner and handed to the runtime. The runtime never looks
    anything up: which tools exist, where they may write, and how much this
    agent is trusted are all decided before the turn starts, from the frozen
    snapshot (§5.1).
    """

    specs: list[ToolSpec]
    context: ToolContext
    autonomy: str = "ask_dangerous"
    gate: ApprovalGate | None = None
    #: Set for tools that need to reach the mission — send_message, ask_user.
    extras: dict[str, Any] = field(default_factory=dict)

    def offered(self) -> list[ProviderToolSpec]:
        return [to_provider_spec(spec) for spec in self.specs]

    def get(self, tool_id: str) -> ToolSpec | None:
        return next((spec for spec in self.specs if spec.id == tool_id), None)

    def needs_approval(self, spec: ToolSpec) -> bool:
        return needs_approval(risk=spec.risk, autonomy=self.autonomy)


async def run(spec: ToolSpec, ctx: ToolContext, arguments: dict[str, Any]) -> ToolResult:
    """Call the handler, turning anything unexpected into a reported failure.

    A tool that raises something else would take the whole mission down; the
    model can be told "that did not work" and try something else, which is the
    outcome an agent can act on.
    """
    try:
        return await spec.handler(ctx, **clean_arguments(spec, arguments))
    except ToolFailed:
        raise
    except TypeError as exc:
        raise ToolFailed("bad_arguments", f"the arguments did not fit: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - a tool must not end the mission
        raise ToolFailed(
            "tool_crashed", f"{type(exc).__name__}: {exc}"
        ) from exc
