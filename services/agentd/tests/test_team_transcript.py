"""The leader is told what is on disk, not only what its team said (§1).

The handover is the one document a person reads at the end of a round, and —
through `earlier_rounds` — the only account of that round the next round's
planner gets. It was being written by a leader that had been shown task
titles and the agents' own replies and nothing else.

On a real run (`PARADOX2`, 1,484,175 tokens, 3 of 7 tasks) it opened:

    Two of five workstreams produced anything. Both were documentation.
    Nothing executable exists yet.
    ...
    No `.html` or `.js` file is named anywhere in the record.

The workspace at that moment held `index.html`, `product.html`,
`checkout.html`, `css/brutal.css`, `js/cart.js` and `js/checkout.js`, and the
app's own `mission.progress` for "Semantic markup, cart and checkout logic"
said `done`. The machine-written half of the same ending was correct — "3 of
7 tasks done" — so the app knew. It just never told the leader.
"""

from __future__ import annotations

from agentd.orchestrator.graph import team_transcript


def result(title, answer, *, ok=True, files=None):
    out = {"task": {"title": title}, "agent_id": "a1", "answer": answer, "ok": ok}
    if files is not None:
        out["files"] = files
    return out


def test_the_files_that_landed_are_named():
    text = team_transcript(
        [
            result(
                "Semantic markup, cart and checkout logic",
                "Built the three pages and wired the cart.",
                files=["index.html", "product.html", "checkout.html", "js/cart.js"],
            )
        ]
    )
    assert "wrote: index.html, product.html, checkout.html, js/cart.js" in text
    # And the agent's own words are still there beside them.
    assert "Built the three pages" in text


def test_a_task_that_wrote_nothing_claims_nothing():
    # No `wrote:` line at all, rather than an empty one. "wrote: " followed by
    # nothing reads as a file with no name.
    text = team_transcript([result("Research the options", "Here is what I found.")])
    assert "wrote:" not in text
    assert "Here is what I found." in text


def test_a_task_that_produced_nothing_still_says_so():
    text = team_transcript([result("Write the tests", "", ok=False)])
    assert "(no answer was produced)" in text


def test_a_failed_task_that_still_wrote_something_says_both():
    """Both halves are true and they are different facts.

    A turn cut off by its token allowance can leave a real file behind and
    still be `failed`. Reporting only the failure loses the file; reporting
    only the file would claim a success nobody had.
    """
    text = team_transcript(
        [result("Build the CSS layer", "", ok=False, files=["css/brutal.css"])]
    )
    assert "wrote: css/brutal.css" in text
    assert "(no answer was produced)" in text


def test_older_results_without_the_field_still_render():
    # `files` is absent on anything that predates it, and on a task whose
    # agent holds no file tools at all (§8).
    text = team_transcript(
        [{"task": {"title": "Plan it"}, "agent_id": "a1", "answer": "Done.", "ok": True}]
    )
    assert "[Plan it]" in text
    assert "Done." in text
    assert "wrote:" not in text


def test_every_task_appears_exactly_once():
    rows = [result(f"Task {i}", f"answer {i}", files=[f"f{i}.md"]) for i in range(4)]
    text = team_transcript(rows)
    for i in range(4):
        assert text.count(f"[Task {i}]") == 1
        assert text.count(f"wrote: f{i}.md") == 1


def test_a_failed_task_that_wrote_something_is_not_called_empty():
    """"produced nothing" was said about a 14,229-byte stylesheet.

    On the `PARADOX2` run, task t4 ("Elegant-brutalism CSS and interaction
    layer") wrote `css/brutal.css` — the app watched `write_file` succeed at
    seq 198 and `edit_file` at 202 — and then ran out of budget before it
    could report. `produced` is false when the reply is empty, so the task is
    `failed`, which is right. Announcing that it *produced nothing* is not:
    the file is on disk, and once the handover began naming written files the
    two halves of one ending contradicted each other.

    `failed` means the turn ended without delivering what was asked. It does
    not mean nothing came out of it.
    """
    from agentd.agents.runner import unfinished_note

    note = unfinished_note(
        {
            "t3": ("done", "Semantic markup, cart and checkout logic"),
            "t4": ("failed", "Elegant-brutalism CSS and interaction layer"),
            "t6": ("pending", "Execute QA pass and file the report"),
        }
    )
    assert "did not finish: Elegant-brutalism CSS and interaction layer" in note
    assert "produced nothing" not in note
    assert "never started: Execute QA pass and file the report" in note
