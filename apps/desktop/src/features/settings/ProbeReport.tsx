/**
 * The four checks, reported one by one (PROJECT_BRIEF.md §3.1).
 *
 * A single tick would tell the user something is wrong without telling them
 * what: a mistyped model id and a model that cannot call tools have completely
 * different fixes.
 */
import type { ProbeResult } from "../../transport/rest";
import { strings } from "../../lib/constants/strings.en";
import { Badge } from "../../components/ui/primitives";

export function ProbeReport({ result }: { result: ProbeResult }) {
  const caps = result.capabilities;
  return (
    <div className="space-y-3 rounded-md border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-100">{strings.probe.title}</span>
        <Badge tone={result.ok ? "good" : "bad"}>
          {result.ok ? strings.probe.passed : strings.probe.failed}
        </Badge>
      </div>

      <ul className="space-y-2">
        {result.checks.map((check) => (
          <li key={check.id} className="flex gap-2 text-sm">
            <span
              aria-hidden
              className={check.ok ? "text-emerald-400" : "text-red-400"}
            >
              {check.ok ? "✓" : "✕"}
            </span>
            <div className="min-w-0">
              <div className="text-slate-200">
                {strings.probe.checkNames[check.id] ?? check.label}
              </div>
              <div className="break-words text-xs text-slate-400">{check.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-xs text-slate-500">{strings.probe.informational}</p>

      {result.ok ? (
        <div className="space-y-1 border-t border-slate-800 pt-2">
          <div className="text-xs font-medium text-slate-300">
            {strings.probe.capabilities}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={caps.tool_calling ? "good" : "neutral"}>
              tools {caps.tool_calling ? "yes" : "no"}
            </Badge>
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
            {/* Surfaced because it silently changes what a request may contain:
                a model that rejects sampling ignores the agent's temperature. */}
            <Badge tone={caps.sampling_params ? "neutral" : "warn"}>
              {caps.sampling_params ? "accepts temperature" : "ignores temperature"}
            </Badge>
            {caps.max_input_tokens ? (
              <Badge>context {caps.max_input_tokens.toLocaleString()}</Badge>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
