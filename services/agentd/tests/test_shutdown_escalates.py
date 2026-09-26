"""A polite shutdown that nobody answers becomes an impolite one.

`should_exit` is uvicorn's graceful stop: it stops accepting and then **waits
for open connections to finish**. The event socket never finishes on its own —
it is a long-lived subscription on the bus — so when the app's window closed,
the server sat waiting for a client that had already gone and the process never
exited.

Measured on the frozen binary, which is the only witness that counts here:

    REST only, venv python          exit 0 in 0.7s
    REST only, frozen               exit 0 in 1.1s
    REST + a whole mission, frozen  exit 0 in 1.2s
    one open WebSocket, frozen      STILL ALIVE after 40s
    the same, with this fix         exit 0 in 4.0s

It had been read as "long sessions leak" and was nothing of the kind. What it
cost: five `agentd.exe` holding the file an installer was trying to replace,
and an update that failed with *"Error opening file for writing"*.
"""

from __future__ import annotations

import io
import time

import agentd.__main__ as entry


class FakeServer:
    """Enough of `uvicorn.Server` for the watchdog to act on."""

    def __init__(self, *, stops_after: float | None) -> None:
        self.should_exit = False
        self.force_exit = False
        self.started = True
        self._stops_after = stops_after
        self._asked_at: float | None = None

    def __setattr__(self, name: str, value: object) -> None:
        object.__setattr__(self, name, value)
        if name == "should_exit" and value:
            object.__setattr__(self, "_asked_at", time.monotonic())

    def __getattribute__(self, name: str):
        # `started` goes False on its own once a well-behaved server has
        # finished shutting down — which is what the watchdog polls for.
        if name == "started":
            after = object.__getattribute__(self, "_stops_after")
            asked = object.__getattribute__(self, "_asked_at")
            if after is not None and asked is not None:
                if time.monotonic() - asked >= after:
                    return False
        return object.__getattribute__(self, name)


def run_watchdog(server, monkeypatch, *, grace: float) -> None:
    monkeypatch.setattr(entry, "FORCE_EXIT_AFTER_SEC", grace)
    # An already-closed stdin is exactly what the parent going away looks like.
    monkeypatch.setattr(entry.sys, "stdin", io.StringIO(""))
    entry.watch_parent(server)
    time.sleep(grace * 4 + 0.4)


def test_a_server_that_stops_politely_is_left_alone(monkeypatch):
    server = FakeServer(stops_after=0.05)
    run_watchdog(server, monkeypatch, grace=0.3)

    assert server.should_exit is True
    assert server.force_exit is False, (
        "closing live connections under a server that was already finishing "
        "would cut off a request that had every chance of completing"
    )


def test_a_shutdown_waiting_on_a_socket_nobody_owns_is_forced(monkeypatch):
    # The real case: an event socket with no client behind it any more, which
    # uvicorn will wait on for ever.
    server = FakeServer(stops_after=None)
    run_watchdog(server, monkeypatch, grace=0.3)

    assert server.should_exit is True
    assert server.force_exit is True


def test_the_grace_is_long_enough_for_a_request_and_short_enough_to_notice():
    # Not a magic number: a real request finishes well inside it, and nobody
    # watching Task Manager should see a leftover.
    assert 1.0 <= entry.FORCE_EXIT_AFTER_SEC <= 10.0
