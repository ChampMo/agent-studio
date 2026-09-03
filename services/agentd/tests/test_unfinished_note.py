"""An ending says what was left undone, not only why it stopped (§1).

A run was asked for a tool, tests for it, and a test run. The leader planned all
three. The clock killed it during the first, and it ended honestly —
`budget_exceeded`, *stopped at the time limit (1302/900)*.

What it never said was **which two things you did not get**. The plan was on the
timeline and the task states were on the timeline, so the information existed;
the only way to use it was to read the log and compare it against what you had
asked for. The person who ran it found out by looking in the folder for a test
file that was not there.

Nothing here is judged or generated. The titles and states come off
`mission.progress` events the run already published.
"""

from __future__ import annotations

from agentd.agents.runner import ending_for, unfinished_note


def states(*rows: tuple[str, str, str]) -> dict[str, tuple[str, str]]:
    return {task_id: (state, label) for task_id, state, label in rows}


def test_a_run_that_finished_everything_says_nothing():
    # There is nothing to report, so nothing is reported. A note on every ending
    # would be noise on exactly the runs that went well.
    assert (
        unfinished_note(
            states(("t1", "done", "Implement it"), ("t2", "done", "Test it"))
        )
        == ""
    )


def test_the_tasks_that_never_started_are_named():
    note = unfinished_note(
        states(
            ("t1", "done", "Implement summarise.py"),
            ("t2", "pending", "Write unit tests for summarise.py"),
            ("t3", "pending", "Run tests and real data"),
        )
    )
    assert "1 of 3 tasks done" in note
    assert "never started" in note
    assert "Write unit tests for summarise.py" in note
    assert "Run tests and real data" in note


def test_running_out_of_room_and_coming_back_empty_are_told_apart():
    """Different failures, different fixes.

    A task that never started needed more room. A task that ran and produced
    nothing needs a different instruction, or a different agent.
    """
    note = unfinished_note(
        states(
            ("t1", "failed", "Draw the atlas"),
            ("t2", "pending", "Review the atlas"),
        )
    )
    assert "produced nothing: Draw the atlas" in note
    assert "never started: Review the atlas" in note


def test_the_note_reaches_the_ending_whatever_stopped_the_run():
    # The case that started this: the reason was already specific, and the
    # summary said only why it stopped.
    reason, summary = ending_for(
        "budget_exceeded",
        "stopped at the time limit (1302/900)",
        states(
            ("t1", "done", "Implement summarise.py"),
            ("t2", "pending", "Write unit tests"),
        ),
    )
    assert reason == "budget_exceeded"  # the specific reason still wins
    assert summary.startswith("stopped at the time limit")
    assert "Write unit tests" in summary


def test_a_cancelled_run_says_what_was_outstanding_too():
    _reason, summary = ending_for(
        "cancelled",
        "stopped by the user",
        states(("t1", "done", "A"), ("t2", "running", "B")),
    )
    assert "1 of 2 tasks done" in summary
    assert "never started: B" in summary


def test_a_chat_with_no_tasks_gets_no_note():
    # A solo chat publishes no `mission.progress`, so there is nothing to count
    # and nothing to say.
    reason, summary = ending_for("completed", "here is your answer", {})
    assert reason == "completed"
    assert summary == "here is your answer"


def test_a_finished_run_is_still_completed():
    """The regression this shape caused, and the reason `_states` exists.

    The map holds `(state, title)` now. Read as a bare state for one commit,
    every comparison against "done" was true, and every finished mission was
    recorded `failed` — including the M6 resume test, which is how it was found.
    """
    reason, summary = ending_for(
        "completed",
        "here is the answer",
        states(("t1", "done", "A"), ("t2", "done", "B")),
    )
    assert reason == "completed"
    assert summary == "here is the answer"


def test_older_state_maps_without_titles_still_work():
    # `ending_for` is called from two places and one of them predates the
    # titles. Counting still works; only the names are missing.
    note = unfinished_note({"t1": "done", "t2": "pending"})
    assert "1 of 2 tasks done" in note
    assert "never started" not in note
