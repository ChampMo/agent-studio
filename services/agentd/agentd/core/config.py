"""Every path, port and tunable in one place (PROJECT_BRIEF.md §4.3).

Nothing else in the backend may compute a data directory or read one of these
environment variables directly — when this drifts, dev and packaged builds
quietly disagree about where the user's data lives.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

APP_NAME = "AgentStudio"

#: Schema version stamped onto every event. Bump ONLY for additive changes
#: (§6.1) — mission_events is append-only forever, so v1 rows must stay readable.
EVENT_SCHEMA_VERSION = 1

#: Hard ceiling for a single redactable payload field, per §9.3.
PAYLOAD_TRUNCATE_BYTES = 8 * 1024

#: Fraction of a budget limit that triggers budget.warning, once per kind (§10).
BUDGET_WARN_RATIO = 0.8


def _repo_root() -> Path | None:
    """Walk up looking for the brief. Present => running from a source checkout."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "PROJECT_BRIEF.md").is_file():
            return parent
    return None


def _platform_data_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        return Path(base) / APP_NAME if base else Path.home() / "AppData" / "Roaming" / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / APP_NAME


def default_data_dir() -> Path:
    """Explicit override wins; then a source checkout; then the OS location."""
    override = os.environ.get("AGENT_STUDIO_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    root = _repo_root()
    if root is not None:
        return root / ".data"
    return _platform_data_dir()


@dataclass(frozen=True)
class AppBudget:
    """App-level floor for mission budgets. Precedence: mission > team > this (§10)."""

    max_llm_calls: int = 40
    max_supersteps: int = 60
    max_tokens: int = 200_000
    timeout_sec: int = 900


#: Origins the browser is allowed to read our responses from.
#:
#: CORS is not the security boundary here — the session token is (§9.1). A
#: non-browser client ignores CORS entirely, which is exactly why the token
#: check exists. What this list does do is stop a page the user happens to have
#: open from reading a response it managed to provoke, so it stays an explicit
#: allowlist rather than "*".
ALLOWED_ORIGINS: tuple[str, ...] = (
    # Vite dev server.
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    # Tauri v2 webview origins: custom scheme on macOS/Linux, http(s) on Windows.
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
)


def allowed_origins() -> tuple[str, ...]:
    """The list above, plus a dev server that had to move off 5173.

    `scripts/dev.mjs` can be pointed at another port so a second copy of the
    app can run beside one already up. The origin has to move with it or the
    page loads and every request fails — as a CORS error, which points at the
    one thing that is not wrong (this file already carries that scar).

    Read from the environment rather than widened to "any loopback port",
    because the launcher knows the port and a shipped build does not set this.

    **A comma-separated list, not one origin.** `127.0.0.1` and `localhost` are
    the same machine and two different origins to a browser, which is why the
    shipped entry for 5173 is a *pair*. The override was a single value and
    carried only the `127.0.0.1` half, so a page opened at
    `http://localhost:<other port>` loaded and then failed every request —
    exactly the scar above, reproduced by the fix for it. Whoever moves the
    port cannot know which spelling the browser will use, so they send both.
    """
    raw = os.environ.get("AGENT_STUDIO_DEV_ORIGIN", "")
    extra = tuple(
        origin
        for origin in (part.strip() for part in raw.split(","))
        # Each entry is checked on its own: one malformed spelling must not
        # take the other down with it, and nothing but loopback gets in.
        if origin.startswith(("http://127.0.0.1:", "http://localhost:"))
    )
    return (*ALLOWED_ORIGINS, *extra)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 8765
    log_level: str = "info"
    budget: AppBudget = field(default_factory=AppBudget)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "agent-studio.db"

    @property
    def db_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.db_path.as_posix()}"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        data_dir=default_data_dir(),
        # The bind address is not configurable on purpose: the backend holds the
        # user's keychain credentials, so it must never leave loopback (§9.1).
        host="127.0.0.1",
        port=int(os.environ.get("AGENT_STUDIO_PORT", "8765")),
        log_level=os.environ.get("AGENT_STUDIO_LOG_LEVEL", "info"),
    )
