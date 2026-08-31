/**
 * The four checks, reported one by one (PROJECT_BRIEF.md §3.1).
 *
 * A single tick would tell the user something is wrong without telling them
 * what: a mistyped model id and a model that cannot call tools have completely
 * different fixes.
 *
 * The headline is driven by the counts, never by `ok`. `ok` means "the endpoint
 * is usable" — models and chat — and an earlier version rendered it as "All
 * checks passed" while structured output was failing underneath.
 */
import type { CheckStatus, ProbeResult } from "../../transport/rest";
import { strings } from "../../lib/constants/strings.en";
import { Badge } from "../../components/ui/primitives";

const MARK: Record<CheckStatus, string> = {
  pass: "✓",
  fail: "✕",
  inconclusive: "?",
};

const MARK_CLASS: Record<CheckStatus, string> = {
  pass: "text-emerald-400",
  fail: "text-red-400",
  inconclusive: "text-amber-400",
};

function headline(result: ProbeResult): { text: string; tone: "good" | "bad" | "warn" } {
  const { passed, failed, inconclusive, total } = result.counts;
  if (passed === total) return { text: strings.probe.allPassed, tone: "good" };
  if (!result.ok) return { text: strings.probe.unusable, tone: "bad" };
  const parts = [`${passed} of ${total} passed`];
  if (inconclusive) parts.push(`${inconclusive} inconclusive`);
  if (failed) parts.push(`${failed} failed`);
  return { text: parts.join(" · "), tone: inconclusive && !failed ? "warn" : "warn" };
}

export function ProbeReport({ result }: { result: ProbeResult }) {
  const caps = result.capabilities;
  const head = headline(result);
  const stored = new Set(result.conclusive ?? []);

  return (
    <div className="space-y-3 rounded-md border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-100">{strings.probe.title}</span>
        <Badge tone={head.tone}>{head.text}</Badge>
      </div>

      <ul className="space-y-2">
        {result.checks.map((check) => (
          <li key={check.id} className="flex gap-2 text-sm">
            <span aria-hidden className={MARK_CLASS[check.status]}>
              {MARK[check.status]}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 text-slate-200">
                {strings.probe.checkNames[check.id] ?? check.label}
                {check.status === "inconclusive" ? (
                  <Badge tone="warn">{strings.probe.inconclusive}</Badge>
                ) : null}
              </div>
              <div className="break-words text-xs text-slate-400">{check.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      {result.counts.inconclusive > 0 ? (
        <p className="text-xs text-amber-400/90">{strings.probe.inconclusiveHint}</p>
      ) : null}
      <p className="text-xs text-slate-500">{strings.probe.informational}</p>

      {result.ok ? (
        <div className="space-y-1 border-t border-slate-800 pt-2">
          <div className="text-xs font-medium text-slate-300">
            {strings.probe.capabilities}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {/* Only what this run proved is shown as recorded; anything
                inconclusive stays out of the profile and out of here. */}
            {stored.has("tool_calling") ? (
              <Badge tone={caps.tool_calling ? "good" : "neutral"}>
                tools {caps.tool_calling ? "yes" : "no"}
              </Badge>
            ) : null}
            {stored.has("structured_output") ? (
              <Badge
                tone={
                  caps.structured_output === "schema"
                    ? "good"
                    : caps.structured_output === "json_object"
                      ? "warn"
                      : "neutral"
                }
              >
                structured: {caps.structured_output}
              </Badge>
            ) : null}
            {stored.has("sampling_params") ? (
              // Surfaced because it silently changes what a request may contain:
              // a model that rejects sampling ignores the agent's temperature.
              <Badge tone={caps.sampling_params ? "neutral" : "warn"}>
                {caps.sampling_params ? "accepts temperature" : "ignores temperature"}
              </Badge>
            ) : null}
            {caps.max_input_tokens ? (
              <Badge>context {caps.max_input_tokens.toLocaleString()}</Badge>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
