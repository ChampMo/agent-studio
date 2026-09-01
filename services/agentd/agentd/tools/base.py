"""What a tool is, and what it is given (§16.1).

Two rules hold the design together:

* **A tool receives its context; it never reads one.** `workspace_root` arrives
  in `ToolContext`, not from a global or from `os.getcwd()`. Two missions can
  run at once against different folders, and a tool that reaches for process
  state would mix them — quietly, and only under load (§16.2).
* **A tool returns text plus a one-line summary.** The text goes to the model,
  the summary goes on the event log. They are different audiences: the model
  needs the file, the timeline needs "read 210 lines of src/main.py".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class ToolFailed(RuntimeError):
    """A tool could not do what was asked, for a reason worth reporting.

    Raised rather than returned so that no caller can mistake a failure for a
    result: `agent.tool.end` carries `ok: false` and the model is told what
    happened, in the same words the user sees on the timeline.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ToolContext:
    """Everything a tool is allowed to know about where it is running."""

    mission_id: str
    agent_id: str
    #: The only folder file tools may touch. None when the mission was launched
    #: without one, which is legal — for a team that has no file tools.
    workspace_root: str | None = None
    #: Set for tools that talk to a person or to teammates; None otherwise.
    extras: dict[str, Any] = field(default_factory=dict)

    def require_workspace(self) -> str:
        if not self.workspace_root:
            # Should be unreachable: the launch gate refuses a mission whose
            # roster carries file tools without a workspace (§16.2). Kept as a
            # failure rather than an assert because the gate and this check are
            # in different processes' worth of code, and the cheap one is here.
            raise ToolFailed(
                "no_workspace",
                "this mission has no workspace folder, so file tools cannot run",
            )
        return self.workspace_root


@dataclass(frozen=True)
class ToolResult:
    """What the model gets back, and what the log records."""

    content: str
    summary: str
    #: True when the content was cut to fit. The model is told in the content
    #: itself as well — a silent truncation is a lie about what the file says.
    truncated: bool = False
    #: Extra fields for `agent.tool.end`, e.g. the number of bytes written.
    details: dict[str, Any] = field(default_factory=dict)
