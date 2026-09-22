"""The CORS allowlist, and the override that had never worked.

`scripts/dev.mjs` moves the web server off 5173 when something else holds it,
and tells the backend the new origin through `AGENT_STUDIO_DEV_ORIGIN`. That
mechanism existed, was documented, and was broken: it sent
`http://127.0.0.1:<port>` only, while a browser handed the app on
`http://localhost:<port>` — the same machine, a different origin — was blocked
on every request.

Found by running it. The shipped entry for 5173 is a *pair* for exactly this
reason, three lines above the code that sent one; nothing tested the override,
so the asymmetry sat there. These are the tests that would have caught it.
"""

from __future__ import annotations

import pytest

from agentd.core.config import ALLOWED_ORIGINS, allowed_origins

VAR = "AGENT_STUDIO_DEV_ORIGIN"


def test_a_shipped_build_gets_exactly_the_shipped_list(monkeypatch) -> None:
    """Nothing is set outside dev, and nothing extra may creep in."""
    monkeypatch.delenv(VAR, raising=False)
    assert allowed_origins() == ALLOWED_ORIGINS


def test_the_two_spellings_of_this_machine_are_both_allowed(monkeypatch) -> None:
    """The bug, stated as the rule it broke.

    A browser treats `127.0.0.1` and `localhost` as different origins, and the
    launcher cannot know which one the page will be opened at.
    """
    monkeypatch.setenv(VAR, "http://127.0.0.1:50851,http://localhost:50851")
    origins = allowed_origins()
    assert "http://127.0.0.1:50851" in origins
    assert "http://localhost:50851" in origins


def test_the_shipped_pair_for_5173_is_still_a_pair() -> None:
    """The precedent the override should have followed."""
    assert "http://127.0.0.1:5173" in ALLOWED_ORIGINS
    assert "http://localhost:5173" in ALLOWED_ORIGINS


def test_one_origin_still_works(monkeypatch) -> None:
    """A list of one is a list. Nothing that set this before has to change."""
    monkeypatch.setenv(VAR, "http://127.0.0.1:6000")
    assert allowed_origins() == (*ALLOWED_ORIGINS, "http://127.0.0.1:6000")


def test_a_bad_entry_does_not_take_the_good_one_with_it(monkeypatch) -> None:
    """Checked one at a time, so half a broken value still leaves a working
    app rather than a page that cannot reach its own backend."""
    monkeypatch.setenv(VAR, "https://evil.example,http://localhost:50851")
    origins = allowed_origins()
    assert "http://localhost:50851" in origins
    assert "https://evil.example" not in origins


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        "*",
        "https://evil.example",
        # Not loopback, however much it reads like it.
        "http://localhost.evil.example:5173",
        "http://127.0.0.1.evil.example:5173",
        # No port: the allowlist is for a dev server, which always has one.
        "http://localhost",
    ],
)
def test_nothing_but_a_loopback_port_gets_in(monkeypatch, value: str) -> None:
    """CORS is not the security boundary — the session token is (§9.1) — but
    this is still an allowlist and an environment variable is still input."""
    monkeypatch.setenv(VAR, value)
    assert allowed_origins() == ALLOWED_ORIGINS


def test_padding_around_an_entry_is_ignored(monkeypatch) -> None:
    monkeypatch.setenv(VAR, " http://localhost:50851 , http://127.0.0.1:50851 ")
    assert allowed_origins() == (
        *ALLOWED_ORIGINS,
        "http://localhost:50851",
        "http://127.0.0.1:50851",
    )
