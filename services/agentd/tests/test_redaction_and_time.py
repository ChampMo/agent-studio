"""Two bugs that only showed up once a real message went through the UI.

Both are the same species: the bus quietly changed data on its way into a table
that can never be corrected. `mission_events` is append-only, so anything lost
here is lost for that mission forever.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from agentd.core.events import EventBus, is_secret_key, redact

from .conftest import draft


# ---- redaction: whole words, not substrings -----------------------------


@pytest.mark.parametrize(
    "key",
    [
        "apiKey",
        "api_key",
        "API_KEY",
        "x-api-key",
        "authorization",
        "Authorization",
        "access_token",
        "refreshToken",
        "bearer",
        "password",
        "passwd",
        "client_secret",
        "credentials",
        "auth",
    ],
)
def test_credential_keys_are_redacted(key):
    assert is_secret_key(key)


@pytest.mark.parametrize(
    "key",
    [
        # The regression. "token" as a substring of a count field was matching,
        # and `{"inputTokens": "[redacted]"}` went into the table.
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "max_tokens",
        "totalTokens",
        # Singular "token" plus a counting word: a measurement, not a secret.
        "token_count",
        "tokensUsed",
        "tokenLimit",
        "remaining_tokens",
        # Ordinary payload fields that must survive untouched.
        "content",
        "agentId",
        "messageId",
        "costUsd",
        "summary",
    ],
)
def test_data_keys_are_not_redacted(key):
    assert not is_secret_key(key)


def test_usage_numbers_survive_the_bus():
    """The cost and MP features are built on these numbers (§6.2). Redacting
    them was silent, permanent, and invisible until a message was sent."""
    payload = {
        "agentId": "a1",
        "messageId": "m1",
        "content": "hello",
        "usage": {
            "inputTokens": 117,
            "outputTokens": 166,
            "cacheReadTokens": 0,
            "costUsd": 0.000123,
        },
    }
    out = redact(payload)
    assert out["usage"] == payload["usage"]


def test_a_secret_nested_beside_usage_is_still_caught():
    payload = {
        "usage": {"inputTokens": 10, "outputTokens": 20},
        "headers": {"Authorization": "Bearer sk-live-123", "X-Api-Key": "sk-abc"},
    }
    out = redact(payload)
    assert out["usage"]["inputTokens"] == 10
    assert out["headers"]["Authorization"] == "[redacted]"
    assert out["headers"]["X-Api-Key"] == "[redacted]"


async def test_published_usage_reaches_the_table_intact(bus, mission_id):
    await bus.publish(
        mission_id,
        {
            "type": "agent.message",
            "payload": {
                "agentId": "a1",
                "messageId": "m1",
                "to": {"kind": "user"},
                "content": "hi",
                "usage": {"inputTokens": 117, "outputTokens": 166},
            },
        },
    )
    stored = (await bus.history(mission_id, 0, 99))[0]
    assert stored["draft"]["payload"]["usage"] == {
        "inputTokens": 117,
        "outputTokens": 166,
    }


# ---- timestamps: replay must agree with live ----------------------------


async def test_replayed_and_live_timestamps_are_identical(bus, mission_id):
    """The bug: SQLite has no timezone type, so a replayed event came back
    without an offset and the browser read it as local time. The same event
    displayed seven hours apart depending on which path delivered it."""
    live = bus._wire(await bus.publish(mission_id, draft("x")))
    replayed = (await bus.history(mission_id, 0, 99))[0]

    assert replayed["id"] == live["id"]
    assert replayed["ts"] == live["ts"]


async def test_every_timestamp_carries_an_offset(bus, mission_id):
    """Without one, the reader has to guess a timezone — and guesses wrong."""
    for i in range(3):
        await bus.publish(mission_id, draft(f"t{i}"))

    for event in await bus.history(mission_id, 0, 99):
        parsed = datetime.fromisoformat(event["ts"])
        assert parsed.tzinfo is not None, event["ts"]
        # And it is genuinely UTC, not merely labelled.
        assert abs(parsed - datetime.now(UTC)) < timedelta(minutes=5)


async def test_replayed_order_matches_stored_order(bus, mission_id):
    for i in range(5):
        await bus.publish(mission_id, draft(f"t{i}"))

    events = await bus.history(mission_id, 0, 99)
    stamps = [datetime.fromisoformat(e["ts"]) for e in events]
    assert stamps == sorted(stamps)
    assert [e["seq"] for e in events] == [1, 2, 3, 4, 5]
