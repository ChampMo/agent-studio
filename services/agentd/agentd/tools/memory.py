"""remember and recall — an agent's own notes (§16.7).

Two things this is honest about.

**It is keyword search, not semantic search.** The tool description says so, so
a model that gets nothing back knows to try other words rather than concluding
it never knew the thing. `sqlite-vec` is in the stack and embeddings would be a
real improvement; claiming to have them now would make `recall` a feature that
lies about why it failed (§1).

**Memories belong to the agent, not the mission.** That is the whole point: a
note taken on Tuesday is there on Thursday. Which mission wrote it is recorded
so a replay can point at where a note came from, but it does not scope the
search.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from ..db.models import AgentMemory
from ..db.session import Database
from .base import ToolContext, ToolFailed, ToolResult

MAX_MEMORY_CHARS = 2000
MAX_RECALL_RESULTS = 10
#: Words too common to narrow anything down.
STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on",
    "that", "this", "with", "as", "at", "by", "from", "what", "which", "was",
}


def _db(ctx: ToolContext) -> Database:
    database = ctx.extras.get("db")
    if database is None:
        raise ToolFailed("no_memory_store", "this mission has no memory store attached")
    return database


async def remember(ctx: ToolContext, *, text: str) -> ToolResult:
    """Write something down for later runs."""
    body = (text or "").strip()
    if not body:
        raise ToolFailed("empty_memory", "there is nothing to remember")
    if len(body) > MAX_MEMORY_CHARS:
        body = body[:MAX_MEMORY_CHARS]

    database = _db(ctx)
    async with database.session() as session:
        session.add(
            AgentMemory(
                id=f"mem-{uuid.uuid4()}",
                agent_id=ctx.agent_id,
                mission_id=ctx.mission_id,
                text=body,
                created_at=datetime.now(UTC),
            )
        )
        await session.commit()

    return ToolResult(
        content="Noted.",
        summary=f"remembered {len(body)} characters",
        details={"bytes": len(body.encode("utf-8"))},
    )


def _terms(query: str) -> list[str]:
    words = [w.lower() for w in re.findall(r"\w+", query)]
    meaningful = [w for w in words if w not in STOPWORDS and len(w) > 2]
    # If the query was nothing but common words, search for them anyway rather
    # than for nothing at all.
    return meaningful or words


async def recall(ctx: ToolContext, *, query: str) -> ToolResult:
    """Look through this agent's own notes, by keyword."""
    if not query or not query.strip():
        raise ToolFailed("empty_query", "a query is required")

    database = _db(ctx)
    async with database.session() as session:
        rows = await session.execute(
            select(AgentMemory)
            .where(AgentMemory.agent_id == ctx.agent_id)
            .order_by(AgentMemory.created_at.desc())
        )
        memories = list(rows.scalars().all())

    terms = _terms(query)
    scored: list[tuple[int, AgentMemory]] = []
    for memory in memories:
        text = memory.text.lower()
        hits = sum(1 for term in terms if term in text)
        if hits:
            scored.append((hits, memory))

    # Most matching terms first, and among equals the newest — a note written
    # later usually corrects one written earlier.
    scored.sort(key=lambda pair: (pair[0], pair[1].created_at), reverse=True)
    top = scored[:MAX_RECALL_RESULTS]

    if not top:
        return ToolResult(
            content=(
                f"Nothing recorded matches {query!r}. This is a keyword search, "
                "so try other words before concluding it was never noted."
            ),
            summary=f"recalled nothing for {query!r}",
            details={"results": 0},
        )

    body = "\n\n".join(
        f"[{memory.created_at.date().isoformat()}] {memory.text}" for _, memory in top
    )
    return ToolResult(
        content=body,
        summary=f"recalled {len(top)} note(s) for {query!r}",
        details={"results": len(top)},
    )
