"""A tool call written as prose is not the agent's answer (§1, §8).

Seen on a real run. DeepSeek ended a round with nothing but its own tool-call
template as text — no call ran — and because a round's summary is its last
message, that markup became the mission's one-line record of what happened.

The test that matters most here is the negative one. Detection has to be narrow
enough that a reply *discussing* tool calls survives untouched: a false positive
would suppress something a person wrote, which is worse than the bug.
"""

from __future__ import annotations

from agentd.providers.leaks import leaked_tool_call

# Exactly what came back, full-width bars and all.
REAL_LEAK = (
    '<｜｜DSML｜｜tool_calls>\n'
    '<｜｜DSML｜｜invoke name="read_file">\n'
    '<｜｜DSML｜｜parameter name="file" string="true">index.html</｜｜DSML｜｜parameter>\n'
    "</｜｜DSML｜｜invoke>\n"
    "</｜｜DSML｜｜tool_calls>"
)


def test_the_template_that_was_actually_seen_is_caught():
    assert leaked_tool_call(REAL_LEAK)


def test_ordinary_prose_is_left_alone():
    assert not leaked_tool_call(
        "I read index.html and the star coordinates are set on lines 121-123."
    )


def test_an_empty_reply_is_not_a_leak():
    # It is its own failure — `task_produced_nothing` — and calling it this
    # would report the wrong cause.
    assert not leaked_tool_call("")


def test_a_reply_that_explains_tool_calls_survives():
    """The false positive that would matter.

    Someone writing about the syntax — an agent reporting *why* a call failed,
    say — must not have their message reclassified as broken markup.
    """
    text = (
        "The previous turn failed because the model emitted a "
        "<｜｜DSML｜｜tool_calls> block as text rather than calling the tool. "
        "That is a known DeepSeek behaviour when the schema is large, and the "
        "fix is to shorten the parameter list before retrying, which I have "
        "now done for the next attempt."
    )
    assert not leaked_tool_call(text)


def test_html_without_the_markers_is_not_a_leak():
    # An agent quoting the page it just wrote is quoting, not leaking.
    assert not leaked_tool_call("<main><h1>Atlas</h1><p>Five constellations.</p></main>")
