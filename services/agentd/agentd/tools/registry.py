"""The tool registry: what exists, how risky it is, what must be hidden (§16.1).

One table, served to the frontend over REST and handed to the model as tool
definitions, so there is no second list to keep in step (§2.2, §15 row 11).

`risk` is not a label for a document — it is the input to a decision. Together
with the agent's `autonomy` it says whether a call stops and asks the user
(§16.4), and that is the only thing standing in front of `bash`, because there
is no sandbox behind it (§2.7).

`redact_fields` exists because `agent.tool.start.input` lands in an append-only
table, forever (§9.3). `write_file` carrying its `content` would copy whole
files into a database nobody can edit; the log keeps the path and the byte count
instead, which is what a timeline needs in order to say what happened.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from ..core.config import PAYLOAD_TRUNCATE_BYTES
from . import fs
from .base import ToolContext, ToolResult

Risk = Literal["safe", "guarded", "dangerous"]

#: Things a tool needs before it can run at all.
#:
#: `workspace` is per mission — the launch gate refuses a mission whose roster
#: carries one of these without a folder chosen (§16.2). `search_provider` is
#: per machine: with no key the tool is not listed at all, rather than listed
#: and failing on every call (§15 row 32).
Requirement = Literal["workspace", "search_provider"]

Handler = Callable[..., Awaitable[ToolResult]]


@dataclass(frozen=True)
class ToolSpec:
    id: str
    title: str
    description: str
    risk: Risk
    input_schema: dict[str, Any]
    handler: Handler
    requires: tuple[Requirement, ...] = ()
    #: Input fields that must never reach the event log in full (§9.3).
    redact_fields: tuple[str, ...] = ()
    #: Ceiling for the result recorded on the log. The bus truncates payloads
    #: anyway; this lets a noisy tool ask for less.
    truncate_result_bytes: int = PAYLOAD_TRUNCATE_BYTES
    #: Extra fields the tool wants on `agent.tool.end`, beyond the summary.
    keep_details: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        """The wire form. Note what is absent: the handler."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "risk": self.risk,
            "requires": list(self.requires),
            "redactFields": list(self.redact_fields),
            "truncateResultBytes": self.truncate_result_bytes,
            "inputSchema": self.input_schema,
        }


def _schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        id="read_file",
        title="Read a file",
        description=(
            "Read a text file from the workspace, by line. Returns numbered lines. "
            "Large files come back in pages: call again with a higher offset."
        ),
        risk="safe",
        requires=("workspace",),
        handler=fs.read_file,
        input_schema=_schema(
            {
                "path": {"type": "string", "description": "Path relative to the workspace."},
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "First line to return, zero-based. Defaults to the start.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": fs.MAX_READ_LIMIT,
                    "description": f"How many lines. Defaults to {fs.DEFAULT_READ_LIMIT}.",
                },
            },
            ["path"],
        ),
    ),
    ToolSpec(
        id="list_dir",
        title="List a directory",
        description="List the files and folders in one directory of the workspace.",
        risk="safe",
        requires=("workspace",),
        handler=fs.list_dir,
        input_schema=_schema(
            {"path": {"type": "string", "description": "Defaults to the workspace root."}},
            [],
        ),
    ),
    ToolSpec(
        id="glob",
        title="Find files by name",
        description=(
            "Find files matching a glob pattern such as `**/*.py`, most recently "
            "changed first. Build folders and version-control directories are skipped."
        ),
        risk="safe",
        requires=("workspace",),
        handler=fs.glob,
        input_schema=_schema(
            {
                "pattern": {"type": "string", "description": "A glob, e.g. `src/**/*.ts`."},
                "path": {"type": "string", "description": "Where to start. Defaults to the root."},
            },
            ["pattern"],
        ),
    ),
    ToolSpec(
        id="grep",
        title="Search file contents",
        description=(
            "Search the workspace for a regular expression and return matching "
            "lines with their file and line number."
        ),
        risk="safe",
        requires=("workspace",),
        handler=fs.grep,
        input_schema=_schema(
            {
                "pattern": {"type": "string", "description": "A regular expression."},
                "path": {"type": "string", "description": "File or directory to search."},
                "glob": {"type": "string", "description": "Only search files matching this glob."},
            },
            ["pattern"],
        ),
    ),
)

BY_ID: dict[str, ToolSpec] = {spec.id: spec for spec in SPECS}


def get(tool_id: str) -> ToolSpec | None:
    return BY_ID.get(tool_id)


def all_specs() -> tuple[ToolSpec, ...]:
    return SPECS


def available(*, has_search_provider: bool) -> list[ToolSpec]:
    """The tools this machine can actually run right now.

    A tool whose requirement is not met is left out rather than listed and
    failing: a model that calls a tool which always fails learns nothing from
    the failure and has already spent a request finding out (§15 row 32).

    `workspace` is not filtered here — it is a per-mission choice, not a
    property of the machine, and the launch gate is where it is enforced.
    """
    return [
        spec
        for spec in SPECS
        if "search_provider" not in spec.requires or has_search_provider
    ]


def needs_workspace(tool_ids: list[str] | tuple[str, ...]) -> list[str]:
    """Which of these tools cannot run without a workspace folder."""
    return [
        tool_id
        for tool_id in tool_ids
        if (spec := BY_ID.get(tool_id)) is not None and "workspace" in spec.requires
    ]


__all__ = [
    "BY_ID",
    "Requirement",
    "Risk",
    "SPECS",
    "ToolContext",
    "ToolSpec",
    "all_specs",
    "available",
    "get",
    "needs_workspace",
]
