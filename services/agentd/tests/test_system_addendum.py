"""The rules an agent is given depend on the tools it was given (§16.6).

Both of these were written after a real run went wrong, and both are added at
turn time rather than saved into the agent's stored prompt — which tool set a
mission hands out is a property of the mission, and a saved copy would drift
from it (§5.1).
"""

from __future__ import annotations

from agentd.tools import registry as tool_registry
from agentd.tools.execution import (
    FILE_DELIVERABLE_RULE,
    UNTRUSTED_CONTENT_RULE,
    system_addendum,
)


def specs(*ids: str):
    return [tool_registry.BY_ID[i] for i in ids]


def test_every_agent_is_asked_to_lead_with_the_outcome():
    """The one rule that is not conditional, and why that is not a
    contradiction.

    "A rule that always fires is a rule nobody reads" is written about
    *findings* — a validator list where an entry present on every team teaches
    people to skim the whole thing. A system prompt is not a list competing for
    attention; it is instructions, and every agent writes replies.

    It earns its place by what it makes possible: the transcript can show one
    line of a two-page report and keep the rest behind it, because the agent
    wrote that line. Without it, folding means taking the first N characters
    and hoping — the app writing a summary it is in no position to write.
    """
    rule = system_addendum(specs("read_file", "list_dir"))
    assert rule is not None
    assert "one plain sentence" in rule


def test_a_web_reader_is_told_that_fetched_text_is_data():
    rule = system_addendum(specs("web_fetch"))
    assert rule is not None
    assert "UNTRUSTED CONTENT" in rule


def test_a_writer_is_told_to_write_the_file_rather_than_paste_it():
    """The failure this exists to stop.

    Asked to "build the landing page", a worker returned the whole page as its
    reply: 8,192 output tokens, cut off partway through a list of CSS
    variables. It retried and spent the whole budget reasoning, emitting
    nothing. The mission then failed because no file had ever been written —
    the next agent found the workspace empty and asked the user where the page
    was.
    """
    rule = system_addendum(specs("write_file"))
    assert rule is not None
    assert "write_file" in rule
    # The reason, not just the instruction: a reply is capped and a file is not.
    assert "limit" in rule
    # And a way out for something too big for one turn. Raising the cap did not
    # fix that: at 16,384 the model spent the whole budget reasoning and emitted
    # neither text nor a tool call, which no cap can solve.
    assert "skeleton" in rule
    assert "edit_file" in rule


def test_edit_file_alone_counts_as_writing():
    rule = system_addendum(specs("edit_file"))
    assert rule is not None
    assert FILE_DELIVERABLE_RULE in rule


def test_an_agent_that_does_both_gets_both_rules():
    # The old version returned one rule and stopped looking. A researcher who
    # also writes the report needs to be told about untrusted text *and* about
    # where the report goes.
    rule = system_addendum(specs("web_fetch", "write_file"))
    assert rule is not None
    assert UNTRUSTED_CONTENT_RULE in rule
    assert FILE_DELIVERABLE_RULE in rule


def test_the_rules_come_in_a_stable_order():
    # Two agents with the same tools must get byte-identical prompts, or the
    # provider's prompt cache misses on every turn for no reason.
    first = system_addendum(specs("web_fetch", "write_file"))
    second = system_addendum(specs("write_file", "web_fetch"))
    assert first == second
