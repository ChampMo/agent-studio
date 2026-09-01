"""`bash` — the tool that is not in a sandbox (§16.7, §2.7).

Everything else in `tools/` has a boundary that holds by construction: a path
resolver, a URL check, a file that refuses to overwrite. This one does not. It
starts a shell with `cwd` set to the workspace, and that shell can `cd`
anywhere, open a socket, and do whatever the person running the app can do.

That is written here, in §2.7 and in the UI, because the alternative is an app
that implies a container it does not have. What actually stands in front of this
tool is the approval gate — one question per call, unless the user turns it off.

Two smaller decisions worth keeping:

* **A timeout, always.** A command that waits for input waits forever, and the
  mission's timeout would be the only thing that noticed, minutes later.
* **The shell must be a real one.** On Windows there is no `bash` unless Git for
  Windows or WSL put one there. Running bash syntax through `cmd.exe` produces
  nonsense that looks like the model's fault, so the tool is simply not offered
  when no shell is found (the same rule as a missing search key, §15 row 32).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

from .base import ToolContext, ToolFailed, ToolResult

DEFAULT_TIMEOUT_SEC = 120
MAX_TIMEOUT_SEC = 600
#: Output kept per stream. Enough for a test run or a build log's tail.
MAX_OUTPUT_CHARS = 30_000

#: Where Git for Windows puts its shell. Tried *before* PATH, because the
#: `bash` on PATH is usually `C:\Windows\System32\bash.exe` — WSL's launcher.
WINDOWS_CANDIDATES = (
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files\Git\usr\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
)


def _runs(shell: str) -> bool:
    """Whether this shell can actually run a command.

    Asked rather than assumed, because of what a live run found:
    `System32\bash.exe` exists on any Windows where the WSL feature is listed,
    sits first on PATH, and fails every command with
    `CreateProcessEntryCommon` when no distribution is installed. The agent
    spent three approvals discovering that, one per attempt, and the failures
    read like the model's fault.
    """
    try:
        result = subprocess.run(
            [shell, "-c", "exit 0"],
            capture_output=True,
            timeout=10,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


@lru_cache(maxsize=1)
def find_shell() -> str | None:
    """A POSIX shell that works here, or None if this machine has none.

    Order matters on Windows: a shell that exists is not the same as a shell
    that runs.
    """
    candidates: list[str] = []
    if sys.platform == "win32":
        candidates += [c for c in WINDOWS_CANDIDATES if Path(c).is_file()]
    for name in ("bash", "sh"):
        if found := shutil.which(name):
            candidates.append(found)

    for candidate in candidates:
        if _runs(candidate):
            return candidate
    return None


def _clip(text: str, label: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n[{label} truncated at {MAX_OUTPUT_CHARS} characters]"


async def bash(
    ctx: ToolContext, *, command: str, timeout: int | None = None
) -> ToolResult:
    """Run a shell command in the workspace."""
    root = ctx.require_workspace()
    if not command or not command.strip():
        raise ToolFailed("empty_command", "no command was given")

    shell = find_shell()
    if shell is None:  # pragma: no cover - depends on the machine
        raise ToolFailed(
            "no_shell",
            "no bash or sh was found on this machine, so shell commands cannot run",
        )

    seconds = DEFAULT_TIMEOUT_SEC if timeout is None else max(1, min(int(timeout), MAX_TIMEOUT_SEC))

    try:
        process = await asyncio.create_subprocess_exec(
            shell,
            "-c",
            command,
            cwd=root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # stdin closed: a command that stops to ask a question would
            # otherwise hold the mission until the timeout, with nothing on
            # screen explaining why.
            stdin=asyncio.subprocess.DEVNULL,
            env={**os.environ, "AGENT_STUDIO_WORKSPACE": root},
        )
    except OSError as exc:
        raise ToolFailed("spawn_failed", f"could not start a shell: {exc}") from exc

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=seconds)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise ToolFailed(
            "timed_out",
            f"the command was still running after {seconds}s and was stopped",
        ) from None

    out = _clip(stdout.decode("utf-8", errors="replace"), "stdout")
    err = _clip(stderr.decode("utf-8", errors="replace"), "stderr")
    code = process.returncode

    body = out
    if err.strip():
        body = f"{body}\n[stderr]\n{err}" if body.strip() else f"[stderr]\n{err}"
    if not body.strip():
        body = "[the command produced no output]"
    body = f"[exit code {code}]\n{body}"

    if code != 0:
        # Reported as a failure so the timeline says so, but the output still
        # goes back: a non-zero exit is usually the most useful thing a command
        # has to say.
        raise ToolFailed("command_failed", body)

    return ToolResult(
        content=body,
        summary=f"ran {command.strip().splitlines()[0][:80]!r} (exit {code})",
        truncated=len(out) >= MAX_OUTPUT_CHARS,
        details={"exitCode": code},
    )
