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

**A timeout has to kill the whole tree, not the shell.** The first version wrote
`wait_for(process.communicate(), timeout)` and, on expiry, `process.kill()`. That
enforces nothing whenever bash *forks* instead of execing — which is every
pipeline. Killing the shell leaves its children running, they still hold the
write end of the stdout pipe, and the cancelled read cannot complete until they
exit. So `wait_for` does not return at the timeout: it returns when the command
finishes on its own.

Found in a real run. Two `grep -r`/`find` calls over the user's Documents folder
were given 120 seconds and took 163 and 789. That alone spent the mission's
15-minute budget, and the timeline recorded "still running after 120s and was
stopped" next to a duration of 789s — the record contradicting itself on the
same row (§1).

Reproduced in three lines: `sleep 12 | cat` with a 2-second timeout returned
after 12.4 seconds. The fix is below, and `test_dangerous_tools.py` holds it to
a wall-clock assertion rather than to the absence of a hang.
"""

from __future__ import annotations

from dataclasses import dataclass

import asyncio
import contextlib
import os
import shutil
import signal
import subprocess
import sys
import time
from functools import lru_cache
from pathlib import Path

from .base import ToolContext, ToolFailed, ToolResult

DEFAULT_TIMEOUT_SEC = 120
MAX_TIMEOUT_SEC = 600
#: How long the tree gets to die after being killed, before we stop waiting and
#: return anyway. The promise this tool makes to the mission budget is that it
#: comes back within `timeout + this`, whatever the command left behind.
KILL_GRACE_SEC = 5
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


def _kill_tree(process: asyncio.subprocess.Process) -> None:
    """Kill the shell *and* everything it started.

    The children are the point. `bash -c 'a | b'` is three processes, and the
    two doing the work are the ones holding the pipe this function's caller is
    blocked reading. Killing only the shell leaves the timeout unenforced.

    Best-effort by construction: the tree is racing us, and a process that
    exited a microsecond ago is not an error. Anything still standing after
    this is handled by the grace cap in `bash()`, which returns regardless.
    """
    if process.returncode is not None:
        return
    if sys.platform == "win32":
        # No process groups to kill on Windows, so ask the OS to walk the tree.
        # /T is the whole point of the call; /F because a console-less child
        # has no window to close politely.
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True,
                timeout=KILL_GRACE_SEC,
            )
        return
    with contextlib.suppress(OSError, ProcessLookupError):
        # `start_new_session=True` below put the shell in its own group, so
        # this reaches the children it forked as well.
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)


def _clip(text: str, label: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n[{label} truncated at {MAX_OUTPUT_CHARS} characters]"


@dataclass(frozen=True)
class ShellOutcome:
    """What a command did. Nothing here is interpreted — the caller decides
    whether a non-zero exit is a failure to report or just an answer."""

    stdout: str
    stderr: str
    exit_code: int | None
    duration_ms: int
    truncated: bool


class ShellUnavailable(RuntimeError):
    """No usable shell on this machine."""


class ShellTimedOut(RuntimeError):
    def __init__(self, seconds: int) -> None:
        super().__init__(seconds)
        self.seconds = seconds


async def run_shell(command: str, *, cwd: str, timeout: int | None = None) -> ShellOutcome:
    """Run one command and come back within `timeout` + a grace period.

    Shared by the `bash` tool and the user's own terminal. The two want
    different things *reported* — a tool turns a non-zero exit into a failure
    the model can act on, a terminal just shows you the exit code — but they
    want exactly the same thing *done*, and the doing is the part that took a
    real run to get right (see the module docstring). One copy of it.
    """
    shell = find_shell()
    if shell is None:  # pragma: no cover - depends on the machine
        raise ShellUnavailable(
            "no bash or sh was found on this machine, so shell commands cannot run"
        )

    seconds = (
        DEFAULT_TIMEOUT_SEC if timeout is None else max(1, min(int(timeout), MAX_TIMEOUT_SEC))
    )
    started = time.monotonic()

    try:
        process = await asyncio.create_subprocess_exec(
            shell,
            "-c",
            command,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # stdin closed: a command that stops to ask a question would
            # otherwise hold everything until the timeout, with nothing on
            # screen explaining why.
            stdin=asyncio.subprocess.DEVNULL,
            env={**os.environ, "AGENT_STUDIO_WORKSPACE": cwd},
            # Its own process group, so a timeout can reach the children the
            # shell forked. Ignored on Windows, which has `taskkill /T`.
            start_new_session=sys.platform != "win32",
        )
    except OSError as exc:
        raise ShellUnavailable(f"could not start a shell: {exc}") from exc

    # Shielded, and deliberately. `wait_for` would otherwise cancel this task on
    # expiry — and the cancellation is itself what blocks, because the pending
    # read cannot finish while a surviving child holds the pipe open. So the
    # order is: stop waiting, kill the tree, *then* collect what was read.
    reading = asyncio.ensure_future(process.communicate())
    try:
        stdout, stderr = await asyncio.wait_for(asyncio.shield(reading), timeout=seconds)
    except TimeoutError:
        _kill_tree(process)
        # With every writer gone the read completes on its own; the cap is
        # there so that even a child this process may not kill — one that
        # escaped into another session — cannot hold things open. Past it, the
        # task is abandoned rather than awaited.
        with contextlib.suppress(TimeoutError, asyncio.CancelledError, OSError):
            await asyncio.wait_for(reading, timeout=KILL_GRACE_SEC)
        # Reap it, so the transport closes here rather than being collected
        # after the loop has shut down (which surfaces as an unraisable
        # "Event loop is closed" somewhere unrelated).
        with contextlib.suppress(TimeoutError, asyncio.CancelledError, OSError):
            await asyncio.wait_for(process.wait(), timeout=KILL_GRACE_SEC)
        raise ShellTimedOut(seconds) from None

    out = _clip(stdout.decode("utf-8", errors="replace"), "stdout")
    err = _clip(stderr.decode("utf-8", errors="replace"), "stderr")
    return ShellOutcome(
        stdout=out,
        stderr=err,
        exit_code=process.returncode,
        duration_ms=int((time.monotonic() - started) * 1000),
        truncated=len(out) >= MAX_OUTPUT_CHARS or len(err) >= MAX_OUTPUT_CHARS,
    )


async def bash(
    ctx: ToolContext, *, command: str, timeout: int | None = None
) -> ToolResult:
    """Run a shell command in the workspace."""
    root = ctx.require_workspace()
    if not command or not command.strip():
        raise ToolFailed("empty_command", "no command was given")

    try:
        outcome = await run_shell(command, cwd=root, timeout=timeout)
    except ShellUnavailable as exc:
        raise ToolFailed("no_shell", str(exc)) from None
    except ShellTimedOut as exc:
        raise ToolFailed(
            "timed_out",
            f"the command was still running after {exc.seconds}s and was stopped",
        ) from None

    body = outcome.stdout
    if outcome.stderr.strip():
        body = (
            f"{body}\n[stderr]\n{outcome.stderr}"
            if body.strip()
            else f"[stderr]\n{outcome.stderr}"
        )
    if not body.strip():
        body = "[the command produced no output]"
    body = f"[exit code {outcome.exit_code}]\n{body}"

    if outcome.exit_code != 0:
        # Reported as a failure so the timeline says so, but the output still
        # goes back: a non-zero exit is usually the most useful thing a command
        # has to say.
        raise ToolFailed("command_failed", body)

    return ToolResult(
        content=body,
        summary=f"ran {command.strip().splitlines()[0][:80]!r} (exit {outcome.exit_code})",
        truncated=outcome.truncated,
        details={"exitCode": outcome.exit_code},
    )
