"""The single event socket (PROJECT_BRIEF.md §7.2).

Connect with `?mission_id=...&since_seq=N`. The server replays everything after
`since_seq`, then switches to live traffic. The seam is exact: catch-up covers
`(since_seq, high_water]` and the live queue holds everything above
`high_water`, so no event is skipped and none is sent twice. Clients still
dedupe on `id`, because a reconnect may legitimately overlap at the edge.

The token travels as a WebSocket subprotocol rather than a query parameter.
Browsers cannot set headers on a WS handshake, and a query string would put the
session token into access logs and browser history (§9.1).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..core import auth

log = logging.getLogger("agentd.ws")
router = APIRouter()

#: 1008 = policy violation. Used for a bad or missing token.
CLOSE_UNAUTHORISED = 1008
#: 1013 = try again later. Used when a client fell too far behind to catch up
#: in memory; it should reconnect with its last seq and be replayed from disk.
CLOSE_LAGGED = 1013


@router.websocket("/ws")
async def event_socket(
    websocket: WebSocket,
    mission_id: str = Query(...),
    since_seq: int = Query(0, ge=0),
) -> None:
    token = auth.token_from_ws_protocols(websocket.scope.get("subprotocols"))
    if not auth.is_valid(token):
        # Rejected before accept(), so an unauthorised caller never gets an
        # open socket at all.
        await websocket.close(code=CLOSE_UNAUTHORISED)
        return

    # Subscribe BEFORE accepting, not after.
    #
    # accept() is what unblocks the client's connect call. Register after it and
    # there is a window where the client believes it is listening while the bus
    # has never heard of it. Sequenced events survive that window — they are on
    # disk and the next reconnect replays them — but ephemeral deltas are
    # fire-and-forget, so they are simply lost, and nothing downstream can tell
    # that they were. Registering first closes the window entirely: anything
    # published between here and the first send waits in the queue.
    bus = websocket.app.state.bus
    sub = await bus.subscribe(mission_id, since_seq)

    try:
        await websocket.accept(subprotocol=auth.WS_PROTOCOL)

        for event in await bus.history(mission_id, sub.since_seq, sub.high_water):
            await websocket.send_json(event)

        while True:
            if sub.lagged:
                await websocket.close(code=CLOSE_LAGGED)
                return
            await websocket.send_json(await sub.queue.get())
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - a dead socket must not take the bus down
        log.exception("event socket failed for mission %s", mission_id)
    finally:
        # Always, or the bus keeps fanning out to a queue nobody drains.
        bus.unsubscribe(sub)
