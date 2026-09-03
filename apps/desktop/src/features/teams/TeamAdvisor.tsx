/**
 * Ask a model to staff a team, or to read the one on screen against a brief.
 *
 * Two things kept visibly apart, because they are different kinds of claim.
 *
 * **What the model said** is prose. It read a paragraph of English and worked
 * out that the work needs somebody who can write files — the thing no rule can
 * do — and it is an opinion.
 *
 * **What the gate said** is `findings`, from the same `validate()` that decides
 * whether a team may launch. It is checkable, and it knows things the model
 * cannot see.
 *
 * They are not merged into one list, and that is the whole design. Asked about
 * a real team on this machine, a model answered *"Yes, Wren has the web
 * research tools"* — while `leader_only_tool` said Wren is the **leader**, and
 * a leader with workers is never assigned a task, so nobody could use them.
 * That is the bug this project actually shipped: a research team that ran to
 * completion and answered from memory. A model looking at that roster sees
 * every tool present, on a real member, spelled correctly.
 *
 * So the model composes and the validator gates, and the screen never lets one
 * pass for the other.
 */
import { useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/primitives";
import { Select } from "../../components/ui/Select";
import { useAgentStore } from "../../stores/agentStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  api,
  type Finding,
  type TeamProposal,
  type ReviewNote,
} from "../../transport/rest";

interface Props {
  /** Null while building a team that has never been saved: there is nothing
   *  to review yet, so only the suggestion is offered. */
  teamId: string | null;
  /** What is on screen right now, so a review reads the team being edited
   *  rather than the last one written to the database. */
  draft: { agent_id: string; seat_index: number; role_in_team: string }[];
  /** Applied by the builder. Nothing here writes to the database (§11). */
  onApply: (proposal: TeamProposal) => void;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "busy"; what: "suggest" | "review" }
  | { kind: "failed"; message: string }
  | {
      kind: "suggested";
      proposal: TeamProposal;
      findings: Finding[];
      attempts: number;
    }
  | {
      kind: "reviewed";
      verdict: string;
      notes: ReviewNote[];
      findings: Finding[];
      attempts: number;
    };

export function TeamAdvisor({ teamId, draft, onApply }: Props) {
  const providers = useSettingsStore((s) => s.providers);
  const activeId = useSettingsStore((s) => s.activeId);
  const usable = providers.filter(
    (p) => p.kind !== "search" && (p.hasKey || p.verifiedAt),
  );
  const [chosen, setProviderId] = useState<string | null>(null);
  // Derived, not stored. `useState(activeId ?? …)` runs once, and on this
  // screen the store is often still loading then — so the initial value would
  // be "" for ever, or a stale id after a profile was deleted. Reading it as a
  // derivation means the list and the selection cannot disagree.
  const providerId =
    chosen && usable.some((p) => p.id === chosen)
      ? chosen
      : (usable.find((p) => p.id === activeId)?.id ?? usable[0]?.id ?? "");
  const [brief, setBrief] = useState("");
  const [state, setState] = useState<Outcome>({ kind: "idle" });

  const ready = Boolean(providerId) && brief.trim().length > 0;
  const busy = state.kind === "busy";

  async function suggest() {
    if (!ready) return;
    setState({ kind: "busy", what: "suggest" });
    try {
      const res = await api.suggestTeam({ provider_id: providerId, brief });
      setState({
        kind: "suggested",
        proposal: res.proposal,
        findings: res.findings,
        attempts: res.attempts,
      });
    } catch (err) {
      setState({ kind: "failed", message: message(err) });
    }
  }

  async function review() {
    if (!ready || !teamId) return;
    setState({ kind: "busy", what: "review" });
    try {
      const res = await api.reviewTeam(teamId, {
        provider_id: providerId,
        brief,
        members: draft,
      });
      setState({
        kind: "reviewed",
        verdict: res.verdict,
        notes: res.notes,
        findings: res.findings,
        attempts: res.attempts,
      });
    } catch (err) {
      setState({ kind: "failed", message: message(err) });
    }
  }

  if (usable.length === 0) {
    return <p className="text-xs text-faint">{strings.advisor.noProvider}</p>;
  }

  return (
    <div className="space-y-2">
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={3}
        placeholder={strings.advisor.briefPlaceholder}
        className={cn(
          "w-full resize-y rounded-card border border-line bg-solid px-2.5 py-2",
          "text-xs text-text placeholder:text-faint",
          "focus:border-accent focus:outline-none",
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[9rem] flex-1">
          <Select
            value={providerId}
            onChange={setProviderId}
            options={usable.map((p) => ({
              value: p.id,
              label: p.name,
              hint: p.model,
            }))}
          />
        </div>
        <Button
          type="button"
          onClick={() => void suggest()}
          disabled={!ready || busy}
        >
          {busy && state.what === "suggest"
            ? strings.advisor.thinking
            : strings.advisor.suggest}
        </Button>
        {/* Absent, not disabled, while there is no saved team: reviewing
            something that does not exist is not a thing to grey out. */}
        {teamId ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => void review()}
            disabled={!ready || busy || draft.length === 0}
          >
            {busy && state.what === "review"
              ? strings.advisor.thinking
              : strings.advisor.review}
          </Button>
        ) : null}
      </div>

      {state.kind === "failed" ? (
        <p className="text-xs text-stop">{state.message}</p>
      ) : null}

      {state.kind === "suggested" ? (
        <Suggestion
          proposal={state.proposal}
          findings={state.findings}
          attempts={state.attempts}
          onApply={() => onApply(state.proposal)}
        />
      ) : null}

      {state.kind === "reviewed" ? (
        <Reviewed
          verdict={state.verdict}
          notes={state.notes}
          findings={state.findings}
          attempts={state.attempts}
        />
      ) : null}
    </div>
  );
}

function Suggestion({
  proposal,
  findings,
  attempts,
  onApply,
}: {
  proposal: TeamProposal;
  findings: Finding[];
  attempts: number;
  onApply: () => void;
}) {
  // The proposal names ids; a person reads names. Resolved from the roster
  // already in memory rather than fetched again.
  const agents = useAgentStore((s) => s.agents);
  const names = (agentId: string) =>
    agents.find((a) => a.id === agentId)?.name ?? agentId;
  return (
    <div className="space-y-2 rounded-card border border-line bg-solid-2 p-2.5">
      <ol className="space-y-1">
        {proposal.members.map((m) => (
          <li key={m.agentId} className="text-xs">
            <span className="text-text">{names(m.agentId)}</span>
            {m.role === "leader" ? (
              <span className="ml-1.5 text-[11px] text-faint">
                {strings.advisor.leader}
              </span>
            ) : null}
            {m.why ? <span className="text-muted"> — {m.why}</span> : null}
            {m.addTools.length > 0 ? (
              <div className="pl-0.5 pt-0.5 text-[11px] text-accent">
                {strings.advisor.adds(m.addTools.join(", "))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      {proposal.gaps.length > 0 ? (
        <div className="space-y-0.5 border-t border-line pt-2">
          {/* Not a failure. A brief that needs a skill nobody has is a normal
              thing to find out, and the fix is to make an agent — which is a
              different screen and a decision the person makes. */}
          <p className="text-[11px] text-faint">{strings.advisor.gapsTitle}</p>
          {proposal.gaps.map((gap) => (
            <p key={gap.role} className="text-xs text-muted">
              <span className="text-text">{gap.role}</span>
              {gap.why ? ` — ${gap.why}` : ""}
              {gap.tools.length > 0 ? (
                <span className="text-faint"> ({gap.tools.join(", ")})</span>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}

      <GateSays findings={findings} />

      <div className="flex items-center gap-2 pt-0.5">
        <Button type="button" onClick={onApply}>
          {strings.advisor.apply}
        </Button>
        <span className="text-[11px] text-faint">
          {strings.advisor.applyHint}
          {attempts > 1 ? ` · ${strings.advisor.attempts(attempts)}` : ""}
        </span>
      </div>
    </div>
  );
}

function Reviewed({
  verdict,
  notes,
  findings,
  attempts,
}: {
  verdict: string;
  notes: ReviewNote[];
  findings: Finding[];
  attempts: number;
}) {
  return (
    <div className="space-y-2 rounded-card border border-line bg-solid-2 p-2.5">
      <p className="text-xs text-text">{verdict}</p>
      {notes.length > 0 ? (
        <ul className="space-y-1">
          {notes.map((note, index) => (
            <li key={index} className="text-xs text-muted">
              {note.about ? (
                <span className="text-text">{note.about}: </span>
              ) : null}
              {note.message}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] text-faint">
        {strings.advisor.modelSays}
        {attempts > 1 ? ` · ${strings.advisor.attempts(attempts)}` : ""}
      </p>
      <GateSays findings={findings} />
    </div>
  );
}

/**
 * What `validate()` says, under its own heading.
 *
 * Never merged into the model's list. The heading is the point: these two
 * blocks answer the same question and only one of them is checkable, and a
 * reader who cannot tell which is which has been given one unreliable list
 * instead of a reliable list beside an opinion.
 */
function GateSays({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;

  // `tool_uncovered` fires once per tool the team does not carry, so a team
  // holding four of thirteen tools produces nine identical-shaped lines — and
  // on the run this was built against they pushed `leader_only_tool`, the one
  // finding that mattered, into seventh place.
  //
  // Not hidden: the six become one line naming all six, which is the same
  // information and the same fact stated once. Everything specific goes first,
  // errors before warnings, because those are about *this* team rather than
  // about the tool catalogue.
  const uncovered = findings.filter((f) => f.code === "tool_uncovered");
  const specific = findings
    .filter((f) => f.code !== "tool_uncovered")
    .sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
    );

  return (
    <div className="space-y-1 border-t border-line pt-2">
      <p className="text-[11px] text-faint">{strings.advisor.gateTitle}</p>
      {specific.map((f, index) => (
        <p
          key={index}
          className={cn(
            "text-xs",
            f.severity === "error" ? "text-stop" : "text-wait",
          )}
        >
          {f.message}
        </p>
      ))}
      {uncovered.length > 0 ? (
        <p className="text-xs text-muted">
          {strings.advisor.uncovered(
            uncovered
              .map((f) => f.subject)
              .filter(Boolean)
              .join(", "),
          )}
        </p>
      ) : null}
    </div>
  );
}

function message(err: unknown): string {
  const detail = (err as { message?: string })?.message;
  return detail || String(err);
}
