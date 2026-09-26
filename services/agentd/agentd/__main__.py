"""Backend entrypoint: `python -m agentd`.

Started by its parent — scripts/dev.mjs in development, Tauri when packaged —
which writes the per-launch session token as the first line of stdin.

Why not `uvicorn --reload`: the reloader re-executes the app in a child process,
and the child does not inherit the stdin we already consumed, so the token would
be lost on every reload. The dev script restarts this process instead (§9.1).
"""

from __future__ import annotations

import logging
import sys
import threading
import time

import uvicorn

from .core import auth
from .core.config import get_settings
from .db.migrate import upgrade_to_head

log = logging.getLogger("agentd")


#: How long a polite shutdown gets before the connections are closed under it.
#:
#: Long enough for a real request to finish and short enough that nobody
#: watching Task Manager sees a leftover. The thing it is waiting out is a
#: WebSocket that will never close itself.
FORCE_EXIT_AFTER_SEC = 3.0


def watch_parent(server: uvicorn.Server) -> None:
    """Shut down when the process that started us goes away.

    The parent holds the write end of our stdin, so when it exits - cleanly,
    crashed, or force-killed - the pipe closes and the read below returns
    empty. Nothing else is a reliable signal: Windows cannot intercept a forced
    kill, so no handler in the parent gets to run, and under PyInstaller the
    parent kills a bootloader that is not this process at all. Left alone, the
    result is an unattended HTTP server on loopback that still holds the user's
    keychain access and a lock on the database (section 9.1).
    """

    def watch() -> None:
        try:
            # Only EOF matters. Anything the parent sends after the token line
            # is read and ignored, so a stray newline is not a shutdown.
            while sys.stdin.readline():
                pass
        except Exception:  # noqa: BLE001 - a closed pipe raises on some platforms
            pass
        log.info("parent process is gone; shutting down")
        server.should_exit = True

        # Graceful first, and then not.
        #
        # `should_exit` is uvicorn's *polite* shutdown: it stops accepting and
        # then **waits for open connections to finish**. The event socket never
        # finishes on its own — it is a long-lived subscription sitting on the
        # bus — so the server waited for a client that had already gone, and
        # the process never exited.
        #
        # That is the whole of the bug. It looked like "long sessions leak" and
        # was nothing of the kind: a backend driven only over REST exits in
        # about a second, with or without a mission, frozen or not. Open one
        # WebSocket first and it hangs for ever. The real app always has one,
        # which is why only the real app did it — and why five of them were
        # found holding `agentd.exe` while an installer was trying to replace
        # that exact file.
        #
        # Nothing is being served at this point: the parent is gone, so the
        # window that owned the socket is gone with it. Waiting past the grace
        # period is waiting for nobody.
        deadline = time.monotonic() + FORCE_EXIT_AFTER_SEC
        while time.monotonic() < deadline:
            if not server.started:
                return
            time.sleep(0.1)
        log.warning("shutdown is waiting on open connections; closing them")
        server.force_exit = True

    threading.Thread(target=watch, name="parent-watchdog", daemon=True).start()


def main() -> int:
    settings = get_settings()
    settings.ensure_dirs()

    try:
        auth.set_token(auth.read_token_from_stdin())
    except (auth.TokenNotConfigured, ValueError) as exc:
        print(f"agentd: {exc}", file=sys.stderr)
        return 2

    # A desktop app has no deploy step, so the schema is brought up to date on
    # boot. Otherwise a new build would meet last build's database.
    upgrade_to_head(settings.db_url)

    # Ready line: the parent waits for this before pointing anything at the
    # port. Carries no secret — the parent already knows the token.
    print(f"agentd: listening on http://{settings.host}:{settings.port}", flush=True)

    # The app object, not an import string: the token lives in module state that
    # was armed above, and only an in-process run is guaranteed to see it.
    from .main import app

    # `Server` rather than `uvicorn.run`, so the watchdog above has something
    # to ask to stop.
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=settings.host,
            port=settings.port,
            log_level=settings.log_level,
            access_log=False,
        )
    )
    watch_parent(server)
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
