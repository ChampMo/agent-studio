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

    def __post_init__(self) -> None:
        self._started_at = self.clock()

    # ---- reads --------------------------------------------------------

    @property
    def elapsed_sec(self) -> float:
        return self.clock() - self._started_at

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

    # ---- checks -------------------------------------------------------

    def _usage(self) -> list[tuple[BudgetKind, float, float]]:
        return [
            ("tokens", self.tokens_used, self.limits.max_tokens),
            ("llm_calls", self.llm_calls_used, self.limits.max_llm_calls),
            ("supersteps", self.supersteps_used, self.limits.max_supersteps),
            ("time", self.elapsed_sec, self.limits.timeout_sec),
        ]

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
        if usage:
            self.tokens_used += int(usage.get("inputTokens") or 0)
            self.tokens_used += int(usage.get("outputTokens") or 0)
            # Cache reads and writes are billed differently but still consume
            # context, so they count against the token ceiling all the same.
            self.tokens_used += int(usage.get("cacheReadTokens") or 0)
            self.tokens_used += int(usage.get("cacheWriteTokens") or 0)
        return self.warnings()

    def record_superstep(self) -> list[dict[str, Any]]:
        self.supersteps_used += 1
        return self.warnings()
