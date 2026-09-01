/**
 * Choosing the folder a mission may touch (PROJECT_BRIEF.md §16.2).
 *
 * Three things this component is careful about.
 *
 * **It never decides.** Every path — picked, typed, or chosen from the recent
 * list — goes to the backend to be resolved and checked. What comes back is
 * what gets displayed, so the path on screen is the path that will be used,
 * with symlinks and `..` already resolved away.
 *
 * **A warning is shown, not swallowed.** Home, Desktop, Documents and a drive
 * root are allowed and unusual. Refusing them would be this app deciding what
 * someone is allowed to work on; saying nothing would be letting them point an
 * agent at everything they own without noticing.
 *
 * **It stays on screen.** Once a mission is running this becomes a line saying
 * where, because an agent writing files somewhere the user cannot see is
 * exactly the thing §1 rules out.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { canPickDirectory, useWorkspaceStore } from "../../stores/workspaceStore";
import { Button, Input } from "../../components/ui/primitives";

export function WorkspacePicker({ required }: { required: boolean }) {
  const { chosen, recent, checking, error } = useWorkspaceStore();
  const { loadRecent, pick, choose, clear } = useWorkspaceStore();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        required && !chosen
          ? "border-amber-800/70 bg-amber-950/20"
          : "border-slate-800 bg-slate-900/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-slate-200">
          {strings.workspace.title}
        </span>
        {required ? (
          <span className="text-[11px] text-amber-400">{strings.workspace.required}</span>
        ) : null}
      </div>

      {chosen ? (
        <div className="space-y-2">
          {/* The resolved path, not what was typed. */}
          <code className="block break-all rounded bg-slate-950/60 px-2 py-1.5 text-xs text-emerald-300">
            {chosen.path}
          </code>
          {chosen.warnings.map((warning) => (
            <p key={warning.code} className="text-[11px] text-amber-400">
              {warning.message} {strings.workspace.broadHint}
            </p>
          ))}
          <Button type="button" variant="ghost" onClick={clear}>
            {strings.workspace.change}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">{strings.workspace.hint}</p>

          {canPickDirectory() ? (
            <Button type="button" variant="secondary" onClick={() => void pick()} disabled={checking}>
              {checking ? strings.workspace.checking : strings.workspace.browse}
            </Button>
          ) : (
            // In the browser there is no OS picker, so a path can be typed. It
            // is checked exactly like a picked one.
            //
            // Deliberately not a <form>: this component is rendered inside the
            // launch form, and HTML has no nested forms — the parser drops the
            // inner tag, so a submit button here would submit the outer one.
            <div className="flex gap-2">
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={strings.workspace.placeholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (typed.trim()) void choose(typed.trim());
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={checking || !typed.trim()}
                onClick={() => typed.trim() && void choose(typed.trim())}
              >
                {checking ? strings.workspace.checking : strings.workspace.use}
              </Button>
            </div>
          )}

          {recent.length > 0 ? (
            <div className="space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-500">
                {strings.workspace.recent}
              </span>
              {recent.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => void choose(entry.path)}
                  disabled={checking}
                  className={cn(
                    "block w-full truncate rounded px-2 py-1 text-left text-xs",
                    entry.exists
                      ? "text-slate-300 hover:bg-slate-800"
                      : "text-slate-600 line-through hover:bg-slate-900",
                  )}
                  title={entry.exists ? entry.path : strings.workspace.missing}
                >
                  {entry.path}
                </button>
              ))}
            </div>
          ) : null}

          {error ? <p className="text-xs text-red-400">{error}</p> : null}
        </div>
      )}
    </div>
  );
}

/** The one-line form shown while a mission runs: where, at a glance. */
export function WorkspaceBanner({ path }: { path: string | null }) {
  if (!path) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-1.5">
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-slate-500">
        {strings.workspace.working}
      </span>
      <code className="min-w-0 flex-1 truncate text-xs text-emerald-300" title={path}>
        {path}
      </code>
    </div>
  );
}
