"""The backend does not outlive the app that started it (§9.1, §12 M7).

Found by packaging: `RunEvent::Exit` kills the process Tauri spawned, which
under PyInstaller's one-file build is a bootloader rather than the server. The
server carried on listening, holding the database and the keychain access, with
nothing left on screen to say so.

The signal is stdin closing, because it is the only one that survives a forced
kill: Windows runs no handler in a process it terminates, so nothing in the
parent can be relied on to do the tidying.
"""

from __future__ import annotations

import io
import time

from agentd.__main__ import watch_parent


class FakeServer:
    """Just the one field the watchdog touches."""

    def __init__(self) -> None:
        self.should_exit = False


def wait_for_exit(server: FakeServer, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server.should_exit:
            return True
        time.sleep(0.01)
    return False


def test_a_closed_stdin_stops_the_server(monkeypatch):
    # An empty stream is a pipe whose writer has gone: read returns nothing
    # rather than blocking.
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    server = FakeServer()
    watch_parent(server)
    assert wait_for_exit(server), "the server kept running with no parent"


def test_lines_from_a_living_parent_are_not_a_shutdown(monkeypatch):
    # A parent that says something after the token - a stray newline, a future
    # message - must not be read as an ending. Only the end of the stream is.
    class OpenPipe(io.StringIO):
        def __init__(self) -> None:
            super().__init__()
            self.lines = ["\n", "still here\n"]

        def readline(self, *args, **kwargs) -> str:
            if self.lines:
                return self.lines.pop(0)
            time.sleep(5)  # a real pipe blocks here; the test ends first
            return ""

    monkeypatch.setattr("sys.stdin", OpenPipe())
    server = FakeServer()
    watch_parent(server)
    assert not wait_for_exit(server, timeout=0.3)


def test_a_stdin_that_raises_is_treated_as_gone(monkeypatch):
    # Some platforms raise on a broken pipe rather than returning empty. Either
    # way the parent is gone, and an exception in a daemon thread would
    # otherwise leave the server up with the watchdog silently dead.
    class Broken:
        def readline(self, *args, **kwargs):
            raise OSError("the pipe is closed")

    monkeypatch.setattr("sys.stdin", Broken())
    server = FakeServer()
    watch_parent(server)
    assert wait_for_exit(server)
