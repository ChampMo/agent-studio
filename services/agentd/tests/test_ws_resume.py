"""M1 proof #4: the socket resumes without gaps or duplicates (§7.2, §12 M1).

This is the property the whole "observable" claim rests on. If a reconnect can
lose an event, the timeline and the scene silently diverge from what actually
happened, and nothing downstream can detect it.

Driven through the real app — routes, token check, subprotocol handshake — not
against the bus directly, because the seam being tested lives in the transport.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from agentd.core import auth
from agentd.core.config import Settings
from agentd.db.migrate import upgrade_to_head
from agentd.db.models import Mission
from agentd.db.session import Database
from agentd.api.ws import CLOSE_UNAUTHORISED
from agentd.main import create_app

TOKEN = "test-token-abcdef"
MISSION = "m-ws"


@pytest.fixture
def client(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'ws.db').as_posix()}"
    upgrade_to_head(url)
    database = Database(url)

    auth.set_token(TOKEN)
    app = create_app(settings=Settings(data_dir=tmp_path), db=database)
    with TestClient(app) as c:
        yield c
    auth._reset_for_tests()


def _run(client, async_fn):
    """Run an async function on the app's own event loop.

    It has to be that loop: the bus's lock and every subscriber queue bind to
    whichever loop touches them first, so publishing from the test thread's own
    loop would talk to a different bus than the socket is reading from.
    """
    return client.portal.call(async_fn)


def _seed_mission(client) -> None:
    async def go():
        db = client.app.state.db
        async with db.session() as s:
            s.add(
                Mission(
                    id=MISSION,
                    kind="chat",
                    team_id=None,
                    goal="ws test",
                    status="running",
                    budget={},
                    roster_snapshot=[],
                    started_at=datetime.now(UTC),
                )
            )
            await s.commit()

    _run(client, go)


def _publish(client, n: int, start: int = 0) -> None:
    async def go():
        bus = client.app.state.bus
        for i in range(start, start + n):
            await bus.publish(
                MISSION,
                {"type": "agent.thought", "payload": {"agentId": "a1", "text": f"t{i}"}},
            )

    _run(client, go)


def _connect(client, since_seq: int, token: str = TOKEN):
    return client.websocket_connect(
        f"/ws?mission_id={MISSION}&since_seq={since_seq}",
        subprotocols=[auth.WS_PROTOCOL, f"{auth.WS_TOKEN_PREFIX}{token}"],
    )


# ---- auth ---------------------------------------------------------------


def test_socket_without_a_token_is_refused(client):
    """A WebSocket gets no CORS preflight, so this check is the only thing
    standing between any open page and the user's credentials (§9.1)."""
    _seed_mission(client)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws?mission_id={MISSION}"):
            pass
    assert exc.value.code == CLOSE_UNAUTHORISED


def test_socket_with_a_wrong_token_is_refused(client):
    _seed_mission(client)
    with pytest.raises(WebSocketDisconnect) as exc:
        with _connect(client, 0, token="not-the-token"):
            pass
    assert exc.value.code == CLOSE_UNAUTHORISED


# ---- the resume criterion ----------------------------------------------


def test_ten_events_cut_in_the_middle_resume_complete_and_in_order(client):
    """The M1 criterion, exactly as written: publish 10, cut the connection
    partway, reconnect with since_seq, and end up with all ten, once each,
    in order."""
    _seed_mission(client)
    _publish(client, 10)

    received = []
    with _connect(client, 0) as ws:
        for _ in range(4):
            received.append(ws.receive_json())

    assert [e["seq"] for e in received] == [1, 2, 3, 4]

    last_seq = received[-1]["seq"]
    with _connect(client, last_seq) as ws:
        for _ in range(6):
            received.append(ws.receive_json())

    seqs = [e["seq"] for e in received]
    assert seqs == list(range(1, 11)), seqs           # nothing missing
    assert len(set(seqs)) == 10                       # nothing duplicated
    assert len({e["id"] for e in received}) == 10     # distinct events, not replays


def test_resume_from_the_end_yields_nothing_stale(client):
    _seed_mission(client)
    _publish(client, 3)
    with _connect(client, 3) as ws:
        _publish(client, 1, start=3)
        live = ws.receive_json()
    assert live["seq"] == 4


def test_history_and_live_traffic_meet_exactly_once(client):
    """The seam: catch-up covers (since_seq, high_water] and the queue holds
    everything above. An event landing on both sides would show up twice; on
    neither, it would vanish."""
    _seed_mission(client)
    _publish(client, 5)

    with _connect(client, 0) as ws:
        _publish(client, 5, start=5)  # live, after subscribe
        seen = [ws.receive_json() for _ in range(10)]

    assert [e["seq"] for e in seen] == list(range(1, 11))
    assert len({e["id"] for e in seen}) == 10


def test_envelope_on_the_wire_matches_the_schema(client):
    _seed_mission(client)
    _publish(client, 1)
    with _connect(client, 0) as ws:
        event = ws.receive_json()

    assert set(event) == {"v", "id", "missionId", "seq", "ts", "draft"}
    assert set(event["draft"]) == {"type", "payload"}
    assert event["v"] == 1
    assert isinstance(event["ts"], str)  # ISO-8601, JSON-safe


def test_deltas_arrive_on_the_socket_without_a_seq(client):
    """Deltas share the socket but not the sequence (§7.1)."""
    _seed_mission(client)

    with _connect(client, 0) as ws:

        async def go():
            bus = client.app.state.bus
            bus.broadcast_ephemeral(
                {
                    "channel": "ephemeral",
                    "type": "agent.message.delta",
                    "missionId": MISSION,
                    "agentId": "a1",
                    "messageId": "msg-1",
                    "index": 0,
                    "text": "chunk",
                }
            )
            await bus.publish(
                MISSION,
                {
                    "type": "agent.message",
                    "payload": {
                        "agentId": "a1",
                        "messageId": "msg-1",
                        "to": {"kind": "user"},
                        "content": "chunk",
                    },
                },
            )

        _run(client, go)

        delta = ws.receive_json()
        message = ws.receive_json()

    assert delta["channel"] == "ephemeral"
    assert "seq" not in delta
    # The very next sequenced event is still seq 1: the delta consumed nothing.
    assert message["seq"] == 1
    assert message["draft"]["payload"]["messageId"] == delta["messageId"]
