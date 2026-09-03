"""The user's own terminal, opened on a mission's workspace (§2.7).

This is **you** running commands, not an agent, and three things follow from
that — each stated here and in the UI rather than left to be discovered:

* **The approval gate does not apply.** `autonomy` governs what an *agent* may
  do without asking. A person typing a command into their own machine is not
  something this app should interrupt, any more than opening a terminal
  yourself would be.

* **It is not in the mission record.** `mission_events` is what the mission
  did; `ls` typed by a person is not that, and streaming a session into an
  append-only table would make the log unbounded for something that is not
  even about the run (§9.3). The commands are gone when the tab is closed.

* **What you change, the agents see.** The terminal opens on the workspace, so
  a file written here is a file the next round reads. That is the point, and it
  is also the reason the tab says so.

One command per request, no pseudo-terminal. That means no `vim`, no program
that prompts, and no Ctrl-C into something already running — and it means the
whole thing reuses `run_shell`, which already gets the hard part right: a
timeout that kills the process *tree* rather than the shell that forked it.

`cd` is the one interactive behaviour worth keeping, so the working directory
travels with the request and comes back with the response. The shell is asked
where it ended up rather than the app guessing, because `cd -`, `cd ~`, a
symlink and a failed `cd` all have answers only the shell knows.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db.models import Mission
from ..tools.shell import (
    MAX_TIMEOUT_SEC,
    ShellTimedOut,
    ShellUnavailable,
    run_shell,
)
from .deps import get_db, require_token

router = APIRouter(dependencies=[Depends(require_token)])

NEWLINE = chr(10)
#: The two-character escape, written into the shell's `printf` format string.
NEWLINE_ESCAPE = chr(92) + "n"

#: Printed after the command so the reply can say where the shell ended up.
#: Unlikely enough not to collide with real output, and stripped before the
#: output is shown.
CWD_MARK = "__AGENT_STUDIO_CWD__"

#: Shorter than the agent's 120s. A person is watching this one and can run it
#: again; a wait with nothing on screen is worse than a timeout.
DEFAULT_TIMEOUT_SEC = 60


class CommandIn(BaseModel):
    command: str = Field(min_length=1, max_length=8000)
    #: Where to run it. Omitted on the first command, which starts at the
    #: mission's workspace.
    cwd: str | None = None
    timeout: int | None = Field(default=None, ge=1, le=MAX_TIMEOUT_SEC)


@router.post("/missions/{mission_id}/terminal")
async def run_command(
    request: Request, mission_id: str, body: CommandIn
) -> dict[str, Any]:
    db = get_db(request)
    async with db.session() as session:
        mission = (
            await session.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
    if mission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")

    root = mission.workspace_root
    if not root:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this run has no workspace folder, so there is nowhere to open a terminal",
        )

    # The client's `cwd` is trusted only as far as "it exists": this is the
    # user's own shell on their own machine, and confining it to the workspace
    # would be a boundary that `cd ..` walks straight through anyway. What is
    # checked is that a stale or invented path cannot make the spawn fail in a
    # way that reads as a broken app.
    start = body.cwd or root
    if not Path(start).is_dir():
        start = root

    # Ask the shell where it ended up rather than parsing `cd` ourselves —
    # `cd -`, `cd ~`, a symlink and a failed `cd` all have answers only it
    # knows. `;` not `&&`, so the marker is printed even when the command fails.
    #
    # `pwd -W` first, and that is not a detail: Git Bash reports `$PWD` in MSYS
    # form (`/c/Users/...`), which Python cannot pass back as a `cwd` — the
    # spawn falls back to the workspace and `cd` silently does nothing. `-W`
    # gives the Windows path; other shells reject the flag and plain `pwd`
    # answers instead.
    wrapped = (
        f"{body.command}" + NEWLINE + "__status=$?; "
        f"printf '{NEWLINE_ESCAPE}{CWD_MARK}%s' \"$(pwd -W 2>/dev/null || pwd)\"; "
        "exit $__status"
    )

    try:
        outcome = await run_shell(
            wrapped, cwd=start, timeout=body.timeout or DEFAULT_TIMEOUT_SEC
        )
    except ShellUnavailable as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    except ShellTimedOut as exc:
        return {
            "stdout": "",
            "stderr": f"stopped after {exc.seconds}s",
            "exitCode": None,
            "cwd": start,
            "durationMs": exc.seconds * 1000,
            "timedOut": True,
            "truncated": False,
        }

    stdout, cwd = _split_cwd(outcome.stdout, start)
    return {
        "stdout": stdout,
        "stderr": outcome.stderr,
        "exitCode": outcome.exit_code,
        "cwd": cwd,
        "durationMs": outcome.duration_ms,
        "timedOut": False,
        "truncated": outcome.truncated,
    }


def _split_cwd(stdout: str, fallback: str) -> tuple[str, str]:
    """Take the trailing marker off, and say where the shell ended up.

    The marker may be missing — the output was clipped, or the command replaced
    the shell with `exec`. Then the directory is simply unchanged, which is a
    better answer than a guess.
    """
    at = stdout.rfind(CWD_MARK)
    if at == -1:
        return stdout, fallback
    cwd = stdout[at + len(CWD_MARK) :].strip() or fallback
    return stdout[:at].rstrip("\n"), cwd


@router.get("/missions/{mission_id}/terminal")
async def terminal_info(request: Request, mission_id: str) -> dict[str, Any]:
    """Where a terminal for this run would start, and whether it can open."""
    db = get_db(request)
    async with db.session() as session:
        mission = (
            await session.execute(select(Mission).where(Mission.id == mission_id))
        ).scalar_one_or_none()
    if mission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such mission")
    return {
        "workspaceRoot": mission.workspace_root,
        "shellAvailable": _has_shell(),
    }


def _has_shell() -> bool:
    from ..tools.shell import find_shell

    return find_shell() is not None


