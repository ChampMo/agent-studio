"""Team validation — one function, two consumers (PROJECT_BRIEF.md §5.2).

Saving accepts anything. Running refuses a team with any `error`. Both read the
*same* list of findings, which is the whole point of decision row 13: two sets
of checks drift, and the pair that drifts is always "what the builder warned
about" versus "what the runner actually refuses". A user would then save a team
the UI called fine and watch it be rejected at launch with a different reason.

So `can_run()` is defined as "no error in `validate()`" and nothing else. There
is no second list of run-time preconditions anywhere.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

from ..db.models import Agent, TeamMember
from . import layouts

Severity = Literal["warn", "error"]


@dataclass(frozen=True)
class Finding:
    code: str
    severity: Severity
    message: str
    #: The member or seat this is about, so the builder can mark it inline
    #: rather than showing a list the user has to match up by hand.
    subject: str | None = None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def validate(
    *,
    layout_id: str | None,
    members: list[TeamMember],
    agents: dict[str, Agent],
    known_tools: set[str] | None = None,
) -> list[Finding]:
    """Every problem with a team, in one pass.

    `known_tools` is the tool registry. It is passed in rather than imported so
    that "nobody covers web_search" can only be raised once web_search exists —
    a warning that always fires teaches people to ignore warnings.
    """
    findings: list[Finding] = []
    layout = layouts.get(layout_id)

    if not members:
        findings.append(
            Finding("empty_team", "error", "A team needs at least one member.")
        )
        return findings

    leaders = [m for m in members if m.role_in_team == "leader"]
    if not leaders:
        # The database enforces "at most one" with a partial unique index. It
        # cannot express "at least one", so that half lives here (§5.2).
        findings.append(
            Finding(
                "no_leader",
                "error",
                "No leader. The orchestrator runs the leader as the supervisor, "
                "so a team without one cannot start.",
            )
        )
    elif len(leaders) > 1:
        # Unreachable through the service, but a hand-edited database or a
        # future migration bug should surface here rather than at launch.
        findings.append(
            Finding(
                "multiple_leaders",
                "error",
                f"{len(leaders)} leaders. Exactly one is required.",
            )
        )

    for member in members:
        agent = agents.get(member.agent_id)
        if agent is None:
            findings.append(
                Finding(
                    "member_missing",
                    "error",
                    "A member refers to an agent that no longer exists.",
                    member.agent_id,
                )
            )
            continue

        if agent.archived_at is not None:
            # Exportable, not runnable (§5.3): the team is still a valid thing
            # to share, it just cannot be launched as it stands.
            findings.append(
                Finding(
                    "member_archived",
                    "error",
                    f"{agent.name} is archived. Restore them or remove them from "
                    "the team before running it.",
                    member.agent_id,
                )
            )

        effective_model = (member.overrides or {}).get("model") or agent.model
        if not effective_model:
            findings.append(
                Finding(
                    "member_has_no_model",
                    "error",
                    f"{agent.name} has no model set, so there is nothing to run them on.",
                    member.agent_id,
                )
            )

        if not 0 <= member.seat_index < layout.seats:
            findings.append(
                Finding(
                    "seat_out_of_range",
                    "error",
                    f"{agent.name} sits at seat {member.seat_index}, but "
                    f"{layout.name} has {layout.seats} seats.",
                    member.agent_id,
                )
            )

    if len(members) == 1:
        findings.append(
            Finding(
                "solo_team",
                "warn",
                "One member. A team of one cannot delegate, so the orchestrator "
                "adds cost without adding anything else.",
            )
        )

    if known_tools:
        covered = {
            tool
            for member in members
            for tool in _effective_tools(member, agents.get(member.agent_id))
        }
        for missing in sorted(known_tools - covered):
            findings.append(
                Finding(
                    "tool_uncovered",
                    "warn",
                    f"Nobody on this team carries {missing}.",
                    missing,
                )
            )

    for member in members:
        agent = agents.get(member.agent_id)
        if agent is None:
            continue
        held = set(_effective_tools(member, agent))
        reads_web = held & WEB_TOOLS
        changes_things = held & WRITE_TOOLS
        if reads_web and changes_things:
            # Not an error: a solo agent that researches and writes is a
            # perfectly ordinary thing to want, and refusing it would be this
            # file deciding how people work. But the two halves together are
            # what turns a page someone else wrote into a command on this
            # machine (§16.6 item 2), and that is worth saying once, by name.
            findings.append(
                Finding(
                    "web_and_write_in_one_agent",
                    "warn",
                    f"{agent.name} can both read the web ({', '.join(sorted(reads_web))}) "
                    f"and change things ({', '.join(sorted(changes_things))}). A page "
                    "it reads can contain instructions aimed at it, and it would be "
                    "the one holding the tools to carry them out. Consider splitting "
                    "the roles - a researcher that only reads, a worker that only "
                    "writes - and letting them talk with send_message.",
                    member.agent_id,
                )
            )

    if not layouts.is_known(layout_id):
        findings.append(
            Finding(
                "unknown_layout",
                "warn",
                f"Layout {layout_id!r} is not one this build knows; "
                f"falling back to {layout.name}.",
            )
        )

    return findings


#: Tools that bring text written by someone else into the agent's context.
WEB_TOOLS = {"web_fetch", "web_search"}

#: Tools that can act on that text - change the user's files or run commands.
WRITE_TOOLS = {"write_file", "edit_file", "bash"}


def _effective_tools(member: TeamMember, agent: Agent | None) -> list[str]:
    """A member's tools after any per-team override (§5.1)."""
    if agent is None:
        return []
    subset = (member.overrides or {}).get("tool_subset")
    return list(subset) if subset is not None else list(agent.tools)


def can_run(findings: list[Finding]) -> bool:
    """The run gate, expressed only in terms of `validate()`.

    Deliberately not a separate set of checks — see the module docstring.
    """
    return not any(f.severity == "error" for f in findings)


def blocking(findings: list[Finding]) -> list[Finding]:
    return [f for f in findings if f.severity == "error"]
