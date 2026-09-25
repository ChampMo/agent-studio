"""Budget guard (PROJECT_BRIEF.md §10, §10.1).

Four separate limits, not one vague "turn": a turn could mean an LLM call, a
graph super-step or a message, and whichever one you picked you would be
measuring the wrong thing somewhere else.

The load-bearing part is `clamp_max_tokens`. Output tokens are only known once a
stream ends, so a check *after* the call can report an overrun but cannot
prevent one. Clamping `max_tokens` to what is left makes the ceiling real: a
single call physically cannot spend more than the mission has.

This module emits event drafts; it never touches the bus. Producers yield, the
caller publishes (§4.1).
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .config import BUDGET_WARN_RATIO, AppBudget

BudgetKind = Literal["tokens", "llm_calls", "supersteps", "time"]


@dataclass(frozen=True)
class BudgetLimits:
    max_llm_calls: int
    max_supersteps: int
    max_tokens: int
    timeout_sec: int

    def as_dict(self) -> dict[str, int]:
        return {
            "max_llm_calls": self.max_llm_calls,
            "max_supersteps": self.max_supersteps,
            "max_tokens": self.max_tokens,
            "timeout_sec": self.timeout_sec,
        }


def resolve_limits(
    mission: dict[str, Any] | None = None,
    team_default: dict[str, Any] | None = None,
    app_default: AppBudget | None = None,
) -> BudgetLimits:
    """Precedence: mission > team default > app default (§10), field by field.

    Per-field rather than whole-object, so a mission that only overrides
    `timeout_sec` still inherits the team's token ceiling instead of silently
    falling back to the app default for everything else.
    """
    app = app_default or AppBudget()
    layers = [mission or {}, team_default or {}]

    def pick(name: str, fallback: int) -> int:
        for layer in layers:
            value = layer.get(name)
            if value is not None:
                return int(value)
        return fallback

    return BudgetLimits(
        max_llm_calls=pick("max_llm_calls", app.max_llm_calls),
        max_supersteps=pick("max_supersteps", app.max_supersteps),
        max_tokens=pick("max_tokens", app.max_tokens),
        timeout_sec=pick("timeout_sec", app.timeout_sec),
    )


#: Held back from the working budget so a run that runs out still has enough
#: left to say what it did. Sized from real runs: the summarise turn is one
#: call, one superstep, and a few thousand tokens with the transcript in it.
#:
#: Two things this is not. It is not a bigger budget — the ceiling the user set
#: is still the ceiling, and the reserve is spent *inside* it. And it is not a
#: share, like `task_allowance`: it is the last slice, and nothing else may
#: touch it.
WRAPUP_TOKENS = 24_000
WRAPUP_SEC = 90.0
#: Never more than this fraction of the limit, so a small budget is not almost
#: entirely reserve. A flat 90 seconds against a 60-second timeout left no
#: working share at all — the run would have stopped before starting.
WRAPUP_RATIO = 0.15


#: What counts against the token ceiling.
#:
#: Cache reads and writes are billed differently and still consume context, so
#: they count here all the same — and on a long run a cache read is most of the
#: bill: one measured run was 79% `cacheReadTokens`.
#:
#: Named once because **anything drawn as `used / limit` has to count what the
#: limit counts**, and this app has had to learn that four separate times: the
#: rail once sat at a quarter full on a run the guard had just stopped for
#: being over, and the team-history panel needed the same four fields again.
TOKEN_FIELDS = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")


def tokens_in(usage: dict[str, Any] | None) -> int:
    """What one `usage` block spent, by the guard's own reckoning."""
    if not usage:
        return 0
    total = 0
    for field in TOKEN_FIELDS:
        value = usage.get(field)
        if isinstance(value, bool):
            # `isinstance(True, int)` is True in Python, and a usage block is
            # model output reaching us over a wire.
            continue
        if isinstance(value, (int, float)):
            total += int(value)
    return total


class BudgetExceeded(Exception):
    """Raised when a limit is hit. The mission ends with reason
    `budget_exceeded` — no asking the user to extend, per §10."""

    def __init__(self, kind: BudgetKind, used: float, limit: float) -> None:
        super().__init__(f"budget exceeded: {kind} {used}/{limit}")
        self.kind: BudgetKind = kind
        self.used = used
        self.limit = limit


@dataclass
class BudgetTracker:
    limits: BudgetLimits
    clock: Callable[[], float] = time.monotonic
    tokens_used: int = 0
    llm_calls_used: int = 0
    supersteps_used: int = 0
    _started_at: float = field(default=0.0, init=False)
    _warned: set[str] = field(default_factory=set, init=False)
    #: Seconds already spent parked on a question, and when the current wait
    #: began. See `paused_for_a_person`.
    _parked_sec: float = field(default=0.0, init=False)
    _parked_since: float | None = field(default=None, init=False)
    #: While True, the four checks below behave as though the wrap-up's share
    #: were already spent, so the work phase stops before eating it.
    _holding_back: bool = field(default=True, init=False)
    #: Which limit ended the work phase, if one did. Read by the runner, which
    #: has to record `budget_exceeded` even though the graph then reached its
    #: end normally and wrote a summary.
    stopped_early: tuple[BudgetKind, float, float] | None = field(
        default=None, init=False
    )

    def __post_init__(self) -> None:
        self._started_at = self.clock()

    # ---- reads --------------------------------------------------------

    @property
    def elapsed_sec(self) -> float:
        """Time the mission spent *working*.

        Not wall clock since it started, because a mission parked on an approval
        is not working — it is waiting for someone to read a command, which is
        exactly what the gate is for. Counting that against a 15-minute limit
        meant turning the gate on made runs die of the clock through no fault of
        the work: measured on two real builds, **93% and 90%** of their 1,300
        seconds was time parked on a question. The work itself took 97 and 126.

        The alternative — leave it counting and tell people to answer faster —
        is a limit punishing the one thing it should encourage.
        """
        parked = self._parked_sec
        if self._parked_since is not None:
            parked += self.clock() - self._parked_since
        return self.clock() - self._started_at - parked

    @property
    def remaining_tokens(self) -> int:
        return max(0, self.limits.max_tokens - self.tokens_used)

    def clamp_max_tokens(self, desired: int) -> int:
        """The per-call ceiling. Never lets one call outspend the mission."""
        return max(0, min(desired, self.remaining_tokens))

    def snapshot(self) -> dict[str, Any]:
        return {
            "tokens": {"used": self.tokens_used, "limit": self.limits.max_tokens},
            "llm_calls": {"used": self.llm_calls_used, "limit": self.limits.max_llm_calls},
            "supersteps": {
                "used": self.supersteps_used,
                "limit": self.limits.max_supersteps,
            },
            "time": {"used": round(self.elapsed_sec, 3), "limit": self.limits.timeout_sec},
        }

    # ---- the clock stops for a person ---------------------------------

    @contextmanager
    def paused_for_a_person(self) -> Iterator[None]:
        """Hold the clock while a question is on screen.

        Only the clock. Tokens, calls and supersteps are things the run spent
        and they stay spent — waiting does not give any of them back.

        Re-entrant on purpose: a tool approval inside a turn that is itself
        inside a paused graph must not restart the timer when the inner one
        finishes. The outer wait owns the pause; the inner ones are already
        inside it.
        """
        outermost = self._parked_since is None
        if outermost:
            self._parked_since = self.clock()
        try:
            yield
        finally:
            if outermost and self._parked_since is not None:
                self._parked_sec += self.clock() - self._parked_since
                self._parked_since = None

    # ---- checks -------------------------------------------------------

    def _usage(self) -> list[tuple[BudgetKind, float, float]]:
        return [
            ("tokens", self.tokens_used, self.limits.max_tokens),
            ("llm_calls", self.llm_calls_used, self.limits.max_llm_calls),
            ("supersteps", self.supersteps_used, self.limits.max_supersteps),
            ("time", self.elapsed_sec, self.limits.timeout_sec),
        ]

    def _reserve(self) -> dict[str, float]:
        """What to hold back from each limit, sized to the limit.

        Tokens and seconds scale: whichever is smaller of the flat amount and a
        fraction of the ceiling, so a tiny budget keeps a working share instead
        of being all reserve.

        Calls and supersteps are counted, not measured: the summary is exactly
        one of each, and there is no useful fraction of a call. They reserve one
        — unless the limit is one, where reserving it would leave nothing able
        to run and the ceiling should simply be reached.
        """
        return {
            "tokens": min(float(WRAPUP_TOKENS), self.limits.max_tokens * WRAPUP_RATIO),
            "llm_calls": min(1.0, max(0.0, self.limits.max_llm_calls - 1)),
            "supersteps": min(1.0, max(0.0, self.limits.max_supersteps - 1)),
            "time": min(WRAPUP_SEC, self.limits.timeout_sec * WRAPUP_RATIO),
        }

    def work_exhausted(self) -> tuple[BudgetKind, float, float] | None:
        """The first limit whose *working* share is spent, or None.

        The working share is the limit minus the wrap-up reserve. Crossing it
        is not an ending: it means stop starting new work, let what is running
        finish, and spend what is left saying where the run got to.

        A limit smaller than its own reserve is not turned into a negative
        ceiling — the reserve is capped at the limit, so a tiny budget simply
        has no working share rather than a nonsensical one.
        """
        if not self._holding_back:
            return None
        reserve = self._reserve()
        for kind, used, limit in self._usage():
            if limit <= 0:
                continue
            working = max(0.0, limit - min(reserve[kind], limit))
            if used >= working:
                return (kind, used, limit)
        return None

    def release_reserve(self) -> None:
        """Hand the wrap-up what was held back for it.

        Called once, immediately before the summary turn. The hard limits are
        untouched: `check` still raises at the ceiling the user actually set,
        so a summariser that runs away is stopped like anything else.
        """
        self._holding_back = False

    def check(self) -> None:
        """Raise if any limit is spent. Call before every LLM call and after."""
        for kind, used, limit in self._usage():
            if limit > 0 and used >= limit:
                raise BudgetExceeded(kind, used, limit)

    def warnings(self) -> list[dict[str, Any]]:
        """budget.warning drafts for kinds that just crossed 80%.

        Fires once per kind per mission. Between calls rather than mid-stream,
        because output tokens are not countable until a stream ends — which is
        safe precisely because `clamp_max_tokens` already caps the overshoot.
        """
        out: list[dict[str, Any]] = []
        for kind, used, limit in self._usage():
            if limit <= 0 or kind in self._warned:
                continue
            if used >= limit * BUDGET_WARN_RATIO:
                self._warned.add(kind)
                out.append(
                    {
                        "type": "budget.warning",
                        "payload": {
                            "kind": kind,
                            "used": round(float(used), 3),
                            "limit": float(limit),
                        },
                    }
                )
        return out

    # ---- writes -------------------------------------------------------

    def record_call(self, usage: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Book one LLM call plus its real token cost; return any new warnings."""
        self.llm_calls_used += 1
        self.tokens_used += tokens_in(usage)
        return self.warnings()

    def record_superstep(self) -> list[dict[str, Any]]:
        self.supersteps_used += 1
        return self.warnings()
