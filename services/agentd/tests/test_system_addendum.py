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
    file_deliverable_rule,
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
    rule = system_addendum(specs("write_file", "edit_file"))
    assert rule is not None
    assert "write_file" in rule
    # The reason, not just the instruction: a reply is capped and a file is not.
    assert "limit" in rule
    # And a way out for something too big for one turn. Raising the cap did not
    # fix that: at 16,384 the model spent the whole budget reasoning and emitted
    # neither text nor a tool call, which no cap can solve.
    assert "skeleton" in rule
    assert "edit_file" in rule


def test_the_way_out_is_one_the_agent_can_actually_take():
    """The strategy has to match the toolbox, or it sends the agent into a wall.

    `PARADOX.ART`: Rowan held `write_file` and not `edit_file`, and was told
    "write_file a working skeleton first ... and then edit_file each section
    in its own turn". It could not do the second half. It did that strategy
    with the only tool it had — `cat >> TEST_PLAN.md <<EOF`, thirty-two shell
    calls, two of them cut off mid-heredoc and repaired with `sed -i`.

    The controlled comparison is inside the same run. Willow had `edit_file`
    and no `bash`, and built a *larger* document — 68,143 bytes against
    64,915 — with two `write_file` calls, eleven `edit_file` calls and no
    shell at all. Same model, same round, same kind of job. The toolbox was
    the variable.
    """
    both = file_deliverable_rule({"write_file", "edit_file"})
    write_only = file_deliverable_rule({"write_file"})
    edit_only = file_deliverable_rule({"edit_file"})

    # The skeleton-then-revise plan needs both halves, so it is offered only
    # when both halves exist.
    assert "edit_file each section" in both
    assert "edit_file each section" not in write_only
    assert "edit_file each section" not in edit_only

    # A write-only agent is told the true shape of its constraint, and told
    # not to reach for the shell to get around it. Compared on one line,
    # because the source is hard-wrapped and a wrapped phrase is still the
    # phrase.
    flat = " ".join(write_only.split())
    assert "a file gets one call and cannot be revised afterwards" in flat
    assert "split it across several files rather than trying to grow one" in flat
    assert "shell redirection" in flat

    # An edit-only agent is not told to write_file anything.
    assert "write_file" not in edit_only.split("You have edit_file")[0]

    # And no variant instructs a tool the agent has not got. Naming one to say
    # it is absent is the point; telling it to use one is the bug.
    assert "with write_file or edit_file" not in write_only
    assert "with write_file or edit_file" not in edit_only


def test_edit_file_alone_counts_as_writing():
    rule = system_addendum(specs("edit_file"))
    assert rule is not None
    assert file_deliverable_rule({"edit_file"}) in rule


def test_an_agent_that_does_both_gets_both_rules():
    # The old version returned one rule and stopped looking. A researcher who
    # also writes the report needs to be told about untrusted text *and* about
    # where the report goes.
    rule = system_addendum(specs("web_fetch", "write_file"))
    assert rule is not None
    assert UNTRUSTED_CONTENT_RULE in rule
    assert file_deliverable_rule({"write_file"}) in rule


def test_the_rules_come_in_a_stable_order():
    # Two agents with the same tools must get byte-identical prompts, or the
    # provider's prompt cache misses on every turn for no reason.
    first = system_addendum(specs("web_fetch", "write_file"))
    second = system_addendum(specs("write_file", "web_fetch"))
    assert first == second


def test_the_agent_is_told_how_many_rounds_it_has():
    """The number is enforced by the loop and stated to the model.

    From the real `PARADOX.ART` run: the agent building `index.html` spent its
    whole turn grepping an existing `app.js` for the ids it had to match —
    eight rounds of it — and was stopped before writing a byte. It was being
    cut off against a budget nobody had told it about, which is the same shape
    as the planner rejecting plans over an instruction ceiling the model had
    never been given.
    """
    from agentd.tools.execution import MAX_TOOL_ROUNDS, file_deliverable_rule

    rule = file_deliverable_rule({"write_file", "edit_file"})
    assert str(MAX_TOOL_ROUNDS) in rule
    assert "{rounds}" not in rule, "the placeholder must not reach a model"
    assert "{strategy}" not in rule and "{tools}" not in rule


def test_the_raw_template_is_never_what_an_agent_gets():
    # Guards the trap this change walked into: two tests compared against the
    # unformatted constant and passed for as long as it had nothing to format.
    from agentd.tools.execution import FILE_DELIVERABLE_RULE, file_deliverable_rule

    assert "{rounds}" in FILE_DELIVERABLE_RULE
    assert FILE_DELIVERABLE_RULE != file_deliverable_rule({"write_file", "edit_file"})


# ---------------------------------------------------------------------------
# What the rule says about the round budget has to be what the loop enforces.
#
# It said "You get about 24 tool calls in this turn". `MAX_TOOL_ROUNDS` bounds
# `for _round in range(MAX_TOOL_ROUNDS)` — one iteration is one model *reply*,
# and a reply may carry any number of calls. On the PARADOX.ART run the mean
# was 1.56 calls per reply (523 calls across 336 replies; 41% of replies
# carried two), so an agent reaching the cap got about 37 calls, not 24.
#
# The app was understating its own budget by a third, in the direction that
# makes an agent hurry — and the same paragraph tells it to write early
# *because* the budget is tight. A number the app enforces must be described
# by the noun it actually counts (PROJECT_BRIEF 1).


def test_the_rule_counts_replies_not_tool_calls():
    from agentd.tools.execution import MAX_TOOL_ROUNDS, file_deliverable_rule

    rule = file_deliverable_rule({"write_file", "edit_file"})
    assert f"{MAX_TOOL_ROUNDS} replies" in rule
    # The old wording, which was false about this app's own loop.
    assert "tool calls in this turn" not in rule


def test_the_rule_says_a_reply_may_carry_several_calls():
    """The consequence, not just the correction.

    Knowing the unit is a reply is only useful alongside the fact that a
    reply can hold more than one call — otherwise "24 replies" reads as a
    tighter budget than "24 tool calls" and the correction costs the agent
    room rather than giving it any.
    """
    from agentd.tools.execution import file_deliverable_rule

    for tools in ({"write_file", "edit_file"}, {"write_file"}, {"edit_file"}):
        rule = file_deliverable_rule(tools)
        assert "several tools at once" in rule, tools


def test_the_rule_does_not_push_two_large_writes_into_one_reply():
    """The batching sentence must not make result-dependence the only reason
    to split a reply.

    The first version said to spend a separate reply "only on what you could
    not have asked for until you saw the last answer" — which sanctions
    merging two independent `write_file` calls. On the run this was measured
    against, Cedar's two adjacent writes cost 12,544 and 9,669 output tokens;
    `max_tokens` bounds the whole reply, so 22,213 against a 16,384 cap
    truncates and **both files are lost**. That failure already cost this run
    513,192 tokens across two turns, and a truncated call never reaches
    `outcomes`, so the model is not told it was dropped.

    Payload size is therefore a second, independent reason to split, and the
    rule has to say so.
    """
    from agentd.tools.execution import file_deliverable_rule

    for tools in ({"write_file", "edit_file"}, {"write_file"}):
        rule = file_deliverable_rule(tools)
        assert "a reply of its own" in rule, tools
        assert "shares one length limit" in rule, tools
        # The wording that made result-dependence the sole sanctioned reason.
        assert "only on what you could not have asked for" not in rule, tools
