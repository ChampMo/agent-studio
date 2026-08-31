"""The event bus: the only writer of `seq` and `ts` (PROJECT_BRIEF.md §2.3).

Three rules this module exists to enforce, and the reason each one matters:

1. **Single writer.** Producers hand over an `EventDraft` with no `seq`, no `ts`,
   no `id`. The bus assigns all three under one lock. In M4 several agents run
   concurrently; if they numbered their own events the sequence would collide and
   the replay would be wrong forever, because the table is append-only.

2. **Persist, then broadcast.** Never the other way round. If a broadcast went
   out and the write then failed, the scene would show an event the replay does
   not contain — a desync with no trace left to debug it.

3. **Deltas never enter the bus.** They have no `seq` at all (§7.1). If a delta
   consumed one, a client resuming from `since_seq` would see a gap and conclude
   it had missed something.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import insert, select

from .config import EVENT_SCHEMA_VERSION, PAYLOAD_TRUNCATE_BYTES
from ..db.models import MissionEvent
from ..db.session import Database

#: Payload fields large or dangerous enough to cap, and the payload types that
#: carry a `truncated` flag to advertise that we did (§9.3).
TRUNCATABLE: dict[str, str] = {
    "agent.tool.start": "input",
    "agent.tool.end": "summary",
}

#: Key names whose values never belong in an append-only table.
#:
#: Matched as whole words, never as substrings. A substring match on "token"
#: also matches `inputTokens`, `outputTokens` and `max_tokens`, and it wrote
#: `{"inputTokens": "[redacted]"}` into the table — destroying, permanently, the
#: exact numbers the cost and budget features are built on.
#:
#: Note the asymmetry: "credential**s**" is here, "token**s**" is not. Plural
#: `tokens` is overwhelmingly a count, plural `credentials` never is. Guessing
#: wrong in this direction loses data that cannot be recovered, so the plural
#: count form is deliberately treated as safe.
_SECRET_WORDS = frozenset(
    {
        "auth",
        "authorization",
        "bearer",
        "credential",
        "credentials",
        "passwd",
        "password",
        "secret",
        "token",
    }
)
#: Words that make a key a quantity, and a quantity is never a credential.
#: `token_count` and `tokensUsed` are measurements; `access_token` is not.
#: Over-redaction is the more expensive mistake here, because the table cannot
#: be corrected afterwards.
_COUNT_WORDS = frozenset(
    {
        "count",
        "counts",
        "len",
        "length",
        "limit",
        "max",
        "min",
        "num",
        "remaining",
        "size",
        "total",
        "totals",
        "usage",
        "used",
    }
)
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_NON_ALNUM = re.compile(r"[^a-z0-9]")
_REDACTED = "[redacted]"


def is_secret_key(key: object) -> bool:
    """Whether a payload key names a credential rather than data."""
    spaced = _CAMEL_BOUNDARY.sub(" ", str(key))
    words = {w for w in re.split(r"[\s_\-.]+", spaced.lower()) if w}
    if words & _COUNT_WORDS:
        return False
    if words & _SECRET_WORDS:
        return True
    # `apiKey`, `api_key` and `x-api-key` all squash to contain "apikey", while
    # neither "api" nor "key" is secret enough to match on its own.
    return "apikey" in _NON_ALNUM.sub("", spaced.lower())

#: A slow client is disconnected rather than allowed to grow an unbounded queue.
#: It reconnects with `since_seq` and loses nothing (§7.2).
SUBSCRIBER_QUEUE_SIZE = 1024


def _utcnow() -> datetime:
    return datetime.now(UTC)


def redact(value: Any) -> Any:
    """Mask secret-looking values anywhere in a payload, at any depth."""
    if isinstance(value, dict):
        return {
            k: (_REDACTED if is_secret_key(k) else redact(v)) for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))


def truncate_payload(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Cap the one field per type that can carry arbitrary bulk.

    Deliberately narrower than "8KB per payload": an `agent.message.content` is
    the record itself, and silently clipping it would make the timeline lie,
    which §1 forbids. The cap applies where the schema has a `truncated` flag to
    declare it — tool input and tool result — because that is the bulk that is
    both unbounded and not the user's own words.
    """
    field_name = TRUNCATABLE.get(event_type)
    if field_name is None or field_name not in payload:
        return payload

    value = payload[field_name]
    if _json_size(value) <= PAYLOAD_TRUNCATE_BYTES:
        return payload

    rendered = json.dumps(value, ensure_ascii=False, default=str)
    clipped = rendered.encode("utf-8")[:PAYLOAD_TRUNCATE_BYTES].decode(
        "utf-8", errors="ignore"
    )
    out = dict(payload)
    out[field_name] = clipped if isinstance(value, str) else f"{clipped}…[truncated]"
    out["truncated"] = True
    return out


# eq=False keeps identity hashing, so subscribers can live in a set: two
# connections with the same sequence numbers are still two connections.
@dataclass(eq=False)
class Subscriber:
    """One live WebSocket.

    The two sequence numbers mark the seam between replay and live traffic:
    catch-up covers `(since_seq, high_water]`, the queue carries everything
    above `high_water`. Every event lands on exactly one side of the seam, so
    nothing is skipped and nothing is sent twice.
    """

    mission_id: str
    since_seq: int
    high_water: int
    queue: asyncio.Queue = field(
        default_factory=lambda: asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
    )
    lagged: bool = False


class EventBus:
    def __init__(
        self,
        db: Database,
        *,
        version: int = EVENT_SCHEMA_VERSION,
        clock: Callable[[], datetime] = _utcnow,
    ) -> None:
        self._db = db
        self._version = version
        self._clock = clock
        self._write_lock = asyncio.Lock()
        self._next_seq: dict[str, int] = {}
        self._subs: dict[str, set[Subscriber]] = {}

    # ---- publishing ---------------------------------------------------

    async def publish(self, mission_id: str, draft: dict[str, Any]) -> dict[str, Any]:
        """Stamp, persist, then broadcast one draft. Returns the envelope."""
        event_type = draft["type"]
        payload = truncate_payload(event_type, redact(draft.get("payload") or {}))

        async with self._write_lock:
            seq = await self._peek_next_seq(mission_id)
            envelope = {
                "v": self._version,
                "id": str(uuid.uuid4()),
                "missionId": mission_id,
                "seq": seq,
                # The bus stamps time too: producers may live in another process
                # whose clock is skewed, and the timeline would then sort wrong.
                "ts": self._clock(),
                "draft": {"type": event_type, "payload": payload},
            }

            await self._persist(envelope)
            self._next_seq[mission_id] = seq + 1

            # Fan out while still holding the lock. Delivery is a non-blocking
            # queue put, and doing it here is what guarantees subscribers see
            # events in seq order rather than in task-scheduling order.
            self._fan_out(mission_id, self._wire(envelope))

        return envelope

    async def publish_many(
        self, mission_id: str, drafts: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        return [await self.publish(mission_id, d) for d in drafts]

    def broadcast_ephemeral(self, frame: dict[str, Any]) -> None:
        """Send a delta straight to subscribers: no seq, no row, no lock (§7.1).

        Dropped silently when a queue is full. Deltas are a rendering nicety; the
        `agent.message` that follows carries the authoritative text.
        """
        for sub in tuple(self._subs.get(frame["missionId"], ())):
            if not sub.queue.full():
                sub.queue.put_nowait(frame)

    # ---- subscribing --------------------------------------------------

    async def subscribe(self, mission_id: str, since_seq: int = 0) -> Subscriber:
        """Register for live events and report where catch-up should stop.

        Registration happens under the write lock so no event can slip through
        between the caller's history read and the first live event. The history
        read itself stays outside the lock — holding it across a large query
        would stall every in-flight stream.
        """
        async with self._write_lock:
            high_water = await self._peek_next_seq(mission_id) - 1
            sub = Subscriber(
                mission_id=mission_id, since_seq=since_seq, high_water=high_water
            )
            self._subs.setdefault(mission_id, set()).add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        subs = self._subs.get(sub.mission_id)
        if subs:
            subs.discard(sub)
            if not subs:
                self._subs.pop(sub.mission_id, None)

    async def history(
        self, mission_id: str, after_seq: int, through_seq: int
    ) -> list[dict[str, Any]]:
        """Events in (after_seq, through_seq], in order — the catch-up read."""
        if through_seq <= after_seq:
            return []
        stmt = (
            select(MissionEvent)
            .where(
                MissionEvent.mission_id == mission_id,
                MissionEvent.seq > after_seq,
                MissionEvent.seq <= through_seq,
            )
            .order_by(MissionEvent.seq)
        )
        async with self._db.session() as s:
            rows = (await s.execute(stmt)).scalars().all()
        return [
            self._wire(
                {
                    "v": r.v,
                    "id": r.id,
                    "missionId": r.mission_id,
                    "seq": r.seq,
                    "ts": r.ts,
                    "draft": {"type": r.type, "payload": r.payload},
                }
            )
            for r in rows
        ]

    # ---- internals ----------------------------------------------------

    async def _peek_next_seq(self, mission_id: str) -> int:
        """Next seq for this mission, recovered from the table on first use so a
        restart continues the sequence rather than restarting it.

        Callers must hold the write lock: it reads a counter they are about to
        advance."""
        cached = self._next_seq.get(mission_id)
        if cached is not None:
            return cached
        stmt = select(MissionEvent.seq).where(
            MissionEvent.mission_id == mission_id
        ).order_by(MissionEvent.seq.desc()).limit(1)
        async with self._db.session() as s:
            highest = (await s.execute(stmt)).scalar()
        nxt = (highest or 0) + 1
        self._next_seq[mission_id] = nxt
        return nxt

    async def _persist(self, envelope: dict[str, Any]) -> None:
        async with self._db.session() as s:
            await s.execute(
                insert(MissionEvent).values(
                    id=envelope["id"],
                    mission_id=envelope["missionId"],
                    seq=envelope["seq"],
                    ts=envelope["ts"],
                    v=envelope["v"],
                    type=envelope["draft"]["type"],
                    payload=envelope["draft"]["payload"],
                )
            )
            await s.commit()

    def _fan_out(self, mission_id: str, wire: dict[str, Any]) -> None:
        for sub in tuple(self._subs.get(mission_id, ())):
            if sub.queue.full():
                # Too far behind to catch up in memory. Mark it and let the
                # connection close; the client resumes from its last seq.
                sub.lagged = True
                continue
            sub.queue.put_nowait(wire)

    @staticmethod
    def _wire(envelope: dict[str, Any]) -> dict[str, Any]:
        """JSON-safe copy for the socket. `ts` becomes ISO-8601, always with an
        offset.

        SQLite has no timezone type: `DateTime(timezone=True)` writes a naive
        string and reads one back, so a replayed event arrived without an offset
        while a live one carried `+00:00`. The browser then read the replayed
        one as local time, and the same event showed up seven hours apart
        depending on which path it came down. That is precisely the failure §1
        rules out — a replay that disagrees with what happened.

        The bus writes UTC, so a naive value read back is UTC and is labelled as
        such here.
        """
        ts = envelope["ts"]
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=UTC)
            return {**envelope, "ts": ts.isoformat()}
        return {**envelope, "ts": ts}
