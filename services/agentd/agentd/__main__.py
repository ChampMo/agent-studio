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

import uvicorn

from .core import auth
from .core.config import get_settings
from .db.migrate import upgrade_to_head

log = logging.getLogger("agentd")


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

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
