"""Run migrations from Python so the app can bring its own database up to date.

A desktop app has no deploy step where someone would run `alembic upgrade` by
hand — the user just launches a new build. Upgrading on boot is the only way the
schema is guaranteed to match the code that is about to use it.
"""

from __future__ import annotations

import sys
from pathlib import Path

from alembic import command
from alembic.config import Config


def _service_root() -> Path:
    """Where `alembic.ini` and the migration scripts live.

    Two answers, because a packaged build has no source tree. Alembic loads
    `env.py` and every revision *by path* rather than by import, so they are
    bundled as data files and PyInstaller unpacks them under `_MEIPASS` (§12
    M7). Getting this wrong is invisible until the first launch on a machine
    that has never seen the repository, and the failure is a database that is
    never created.
    """
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[2]


SERVICE_ROOT = _service_root()


def _config(url: str | None = None) -> Config:
    cfg = Config(str(SERVICE_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVICE_ROOT / "agentd" / "db" / "migrations"))
    if url:
        # `attributes` is Alembic's supported channel for handing values to
        # env.py in-process. Tests use it to migrate a temp database.
        cfg.attributes["url"] = url
    return cfg


def upgrade_to_head(url: str | None = None) -> None:
    command.upgrade(_config(url), "head")
