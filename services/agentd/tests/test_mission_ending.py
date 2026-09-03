"""`completed` has to mean something was completed (§1, §1.1).

Found by running a real mission. A two-agent team was asked for an HTML file and
a notes file; all three tasks failed, nothing was written, and the leader's own
summary said *"The deliverables were not produced. There is no `index.html` and
no `NOTES.md`."*

The row said **completed**. And because `_finalise_team` credits
`total_missions` on exactly that word, both agents were also credited with a
mission they had not finished — turning the one number on the roster card that
is supposed to be a fact into something untrue.
"""

from __future__ import annotations

import pytest

from agentd.agents.runner import ending_for


def test_a_run_where_every_task_failed_did_not_complete():
    reason, summary = ending_for("completed", "", {"t1": "failed", "t2": "failed"})
    assert reason == "failed"
    assert "2 of 2" in summary


def test_a_partly_finished_run_is_not_completed_either():
    """The gap the first version left, walked through by the very next run.

    The atlas task failed, the notes task succeeded, and the leader's own
    summary said "index.html is missing, so the mission is not complete" — over
    a row that said `completed`. There is no honest reading of that word which
    covers a run that did not do what it was asked.
    """
    reason, summary = ending_for("completed", "", {"t1": "done", "t2": "failed"})
    assert reason == "failed"
    assert "1 of 2" in summary


def test_every_task_done_is_a_completed_run():
    reason, _ = ending_for("completed", "", {"t1": "done", "t2": "done"})
    assert reason == "completed"


def test_the_leader_s_own_summary_is_kept_when_there_is_one():
    # Kept, not replaced. The tally is appended after it, because the leader's
    # words are the answer and the count is the record — and a run in this
    # state is `failed`, so no artifact is written from either.
    reason, summary = ending_for(
        "completed", "I could not find the files.", {"t1": "failed"}
    )
    assert reason == "failed"
    assert summary.startswith("I could not find the files.")


@pytest.mark.parametrize("other", ["cancelled", "budget_exceeded", "crashed", "failed"])
def test_a_more_specific_reason_always_wins(other: str):
    # Every one of these says something truer about why the work stopped than
    # "failed" does, and a run can be cancelled with every task still pending.
    reason, _ = ending_for(other, "why", {"t1": "failed"})
    assert reason == other


def test_a_run_with_no_tasks_is_left_alone():
    # A chat, or a team stopped before the plan produced anything. There is no
    # evidence either way, and inventing `failed` would be the same kind of lie
    # in the other direction.
    reason, _ = ending_for("completed", "hello", {})
    assert reason == "completed"


def test_pending_is_not_success():
    # A task that never ran is not a task that succeeded.
    reason, _ = ending_for("completed", "", {"t1": "pending", "t2": "running"})
    assert reason == "failed"


# ---- how far through the plan a run got --------------------------------
#
# The sidebar lists every past run and could say nothing about what any of them
# managed. The header can — "10 of 12 tasks done" — but only for the run that
# is open, because it counts `mission.progress` off that run's own log, and a
# list of seventeen rows cannot read seventeen logs.


def test_the_counts_come_from_the_same_normaliser_the_ending_uses():
    """Two readings of one thing, not two counts that can drift (§2.1)."""
    from agentd.agents.runner import _states

    states = _states(
        {
            "t1": ("done", "Write it"),
            "t2": ("done", "Review it"),
            "t3": ("failed", "Build it"),
            "t4": ("pending", "Ship it"),
        }
    )
    done = sum(1 for state, _title in states if state == "done")
    assert (done, len(states)) == (2, 4)


def test_the_older_shape_still_counts():
    # One caller kept titles and the other did not; `_states` exists for that,
    # and a tuple read as a string once made every comparison true.
    from agentd.agents.runner import _states

    states = _states({"t1": "done", "t2": "running"})
    assert sum(1 for state, _title in states if state == "done") == 1
