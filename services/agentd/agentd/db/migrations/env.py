"""Alembic environment, async flavour.

The URL is never read from alembic.ini — it comes from agentd.core.config, the
one place allowed to decide where the user's data lives (PROJECT_BRIEF.md §4.3).
"""

from __future__ import annotations

import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy.engine import Connection
from sqlalchemy import pool

from agentd.core.config import get_settings
from agentd.db.models import Base

config = context.config
target_metadata = Base.metadata


def _url() -> str:
    """In-process caller (tests, app boot) wins, then `-x url=`, then config."""
    return (
        config.attributes.get("url")
        or context.get_x_argument(as_dictionary=True).get("url")
        or get_settings().db_url
    )


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # SQLite cannot ALTER most things in place; batch mode rewrites the
        # table instead. Without this, the first column change in M2 fails.
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _url()
    engine = async_engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    async with engine.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
