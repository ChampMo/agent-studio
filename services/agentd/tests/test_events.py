"""M1 proof #1: the event bus keeps its three promises (PROJECT_BRIEF.md §2.3, §7).

These are not smoke tests. Each one pins a rule that, if it broke, would corrupt
the append-only table in a way no later fix could repair.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from agentd.core.events import EventBus, redact, truncate_payload
from agentd.db.models import MissionEvent

from .conftest import draft


async def test_seq_is_gapless_and_starts_at_one(bus, mission_id):
    for i in range(5):
        await bus.publish(mission_id, draft(f"t{i}"))

    events = await bus.history(mission_id, 0, 999)
    assert [e["seq"] for e in events] == [1, 2, 3, 4, 5]


async def test_bus_assigns_meta_and_ignores_producer_supplied_values(bus, mission_id):
    """Producers yield drafts. seq/ts/id are the bus's alone (§2.3)."""
    env = await bus.publish(
        mission_id,
        {"type": "agent.thought", "payload": {"agentId": "a1", "text": "hi"},
         "seq": 999, "ts": "1999-01-01T00:00:00Z", "id": "forged"},
    )
    assert env["seq"] == 1
    assert env["id"] != "forged"
    assert env["ts"].year >= 2024
    assert env["v"] == 1


async def test_concurrent_publishes_do_not_collide(bus, mission_id):
    """M4 runs agents in parallel. Under one writer lock the sequence must stay
    gapless and unique no matter how the tasks interleave."""
    await asyncio.gather(*(bus.publish(mission_id, draft(f"t{i}")) for i in range(50)))

    events = await bus.history(mission_id, 0, 10_000)
    seqs = [e["seq"] for e in events]
    assert seqs == list(range(1, 51))
    assert len({e["id"] for e in events}) == 50


async def test_persist_happens_before_broadcast(db, mission_id):
    """If a broadcast escaped before the write, the scene could show an event the
    replay does not contain — a desync with nothing left to debug it."""
    observed: list[bool] = []

    class SpyBus(EventBus):
        def _fan_out(self, mid, wire):
            # At fan-out time the row must already be readable.
            observed.append(wire["seq"] is not None)
            super()._fan_out(mid, wire)

    bus = SpyBus(db)
    sub = await bus.subscribe(mission_id, since_seq=0)
    await bus.publish(mission_id, draft("x"))

    assert observed == [True]
    async with db.session() as s:
        rows = (await s.execute(select(MissionEvent))).scalars().all()
    assert len(rows) == 1
    # And the subscriber got the same event that is now on disk.
    assert sub.queue.get_nowait()["id"] == rows[0].id


async def test_unique_constraint_backstops_a_second_writer(db, mission_id):
    """The DB is the last line of defence if a second writer ever appears."""
    from sqlalchemy.exc import IntegrityError

    bus = EventBus(db)
    await bus.publish(mission_id, draft("first"))

    rogue = EventBus(db)
    rogue._next_seq[mission_id] = 1  # pretend it never saw the first event

    with pytest.raises(IntegrityError):
        await rogue.publish(mission_id, draft("collision"))


async def test_seq_resumes_after_restart(db, mission_id):
    """A fresh process must continue the sequence, not restart it."""
    first = EventBus(db)
    for i in range(3):
        await first.publish(mission_id, draft(f"a{i}"))

    second = EventBus(db)  # cold, empty in-memory counters
    env = await second.publish(mission_id, draft("after restart"))
    assert env["seq"] == 4


async def test_deltas_never_consume_a_seq(bus, mission_id):
    """§7.1: if a delta took a seq, a resuming client would see a gap and
    believe it had missed an event."""
    await bus.publish(mission_id, draft("before"))
    sub = await bus.subscribe(mission_id, since_seq=1)

    for i in range(3):
        bus.broadcast_ephemeral(
            {
                "channel": "ephemeral",
                "type": "agent.message.delta",
                "missionId": mission_id,
                "agentId": "a1",
                "messageId": "msg-1",
                "index": i,
                "text": f"chunk{i}",
            }
        )
    after = await bus.publish(mission_id, draft("after"))

    assert after["seq"] == 2  # not 5

    drained = []
    while not sub.queue.empty():
        drained.append(sub.queue.get_nowait())
    assert [d.get("channel") for d in drained] == ["ephemeral"] * 3 + [None]
    assert all("seq" not in d for d in drained if d.get("channel") == "ephemeral")

    # Nothing ephemeral reached the table.
    stored = await bus.history(mission_id, 0, 999)
    assert [e["draft"]["type"] for e in stored] == ["agent.thought", "agent.thought"]


async def test_redaction_masks_secrets_at_any_depth():
    payload = {
        "agentId": "a1",
        "callId": "c1",
        "tool": "http",
        "input": {
            "url": "https://example.test",
            "headers": {"Authorization": "Bearer sk-live-123", "X-Api-Key": "sk-abc"},
            "retries": [{"password": "hunter2"}],
        },
    }
    out = redact(payload)
    assert out["input"]["headers"]["Authorization"] == "[redacted]"
    assert out["input"]["headers"]["X-Api-Key"] == "[redacted]"
    assert out["input"]["retries"][0]["password"] == "[redacted]"
    assert out["input"]["url"] == "https://example.test"  # not over-eager


async def test_tool_input_is_truncated_and_flagged():
    payload = {"agentId": "a", "callId": "c", "tool": "read", "input": "x" * 20_000}
    out = truncate_payload("agent.tool.start", payload)
    assert out["truncated"] is True
    assert len(out["input"].encode()) <= 8 * 1024 + 32


async def test_agent_message_content_is_never_truncated():
    """The message IS the record. Clipping it would make the timeline lie (§1)."""
    payload = {"agentId": "a", "messageId": "m", "to": {"kind": "user"},
               "content": "y" * 50_000}
    out = truncate_payload("agent.message", payload)
    assert out["content"] == payload["content"]
    assert "truncated" not in out
