"""Run migrations from Python so the app can bring its own database up to date.

A desktop app has no deploy step where someone would run `alembic upgrade` by
hand — the user just launches a new build. Upgrading on boot is the only way the
schema is guaranteed to match the code that is about to use it.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

SERVICE_ROOT = Path(__file__).resolve().parents[2]


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
