/**
 * Choosing the folder a mission may touch (PROJECT_BRIEF.md §16.2).
 *
 * Three things this component is careful about.
 *
 * **It never decides.** Every path — picked or typed — goes to the backend to
 * be resolved and checked. What comes back is what gets displayed, so the path
 * on screen is the path that will be used, with symlinks and `..` already
 * resolved away.
 *
 * **A warning is shown, not swallowed.** Home, Desktop, Documents and a drive
 * root are allowed and unusual. Refusing them would be this app deciding what
 * someone is allowed to work on; saying nothing would be letting them point an
 * agent at everything they own without noticing.
 *
 * **It stays on screen.** Once a mission is running this becomes a line saying
 * where, because an agent writing files somewhere the user cannot see is
 * exactly the thing §1 rules out.
 *
 * One field and one button, and the button is whichever of the two things is
 * useful right now: **Browse** while the field is empty, **Use this folder**
 * once there is a path in it. There used to be three ways in stacked on top of
 * each other — a dashed drop-target, the field, and a list of recent folders —
 * for a choice made once per run, in a form whose other two fields are a name
 * and a dropdown.
 */
import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import {
  canPickDirectory,
  useWorkspaceStore,
} from "../../stores/workspaceStore";
import { Button } from "../../components/ui/primitives";

export function WorkspacePicker({ required }: { required: boolean }) {
  const { chosen, checking, error } = useWorkspaceStore();
  const { pick, choose, clear } = useWorkspaceStore();
  const [typed, setTyped] = useState("");

  const path = typed.trim();
  // Empty field: the only thing you can do is go and find a folder. With a path
  // in it, the button is what turns that path into the boundary.
  const browsing = path === "";
  const canBrowse = canPickDirectory();

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        required && !chosen
          ? "border-attn-edge bg-attn-soft"
          : "border-line bg-solid",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-text">
          {strings.workspace.title}
        </span>
        {required ? (
          <span className="text-[11px] text-attn">
            {strings.workspace.required}
          </span>
        ) : null}
      </div>

      {chosen ? (
        <div className="space-y-2">
          {/* The resolved path, not what was typed. */}
          <code className="block break-all rounded bg-solid px-2 py-1.5 text-xs text-done">
            {chosen.path}
          </code>
          {chosen.warnings.map((warning) => (
            <p key={warning.code} className="text-[11px] text-attn">
              {warning.message} {strings.workspace.broadHint}
            </p>
          ))}
          <Button type="button" variant="ghost" onClick={clear}>
            {strings.workspace.change}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted">{strings.workspace.hint}</p>

          {/* Deliberately not a <form>: this component is rendered inside the
              launch form, and HTML has no nested forms — the parser drops the
              inner tag, so a submit button here would submit the outer one. */}
          <div className="flex gap-2">
            <label htmlFor="workspace-path" className="sr-only">
              {strings.workspace.title}
            </label>
            <input
              id="workspace-path"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={strings.workspace.placeholder}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const value = e.currentTarget.value.trim();
                if (value) void choose(value);
              }}
              // The same field as the title above it. A folder is not a more
              // important thing to type than the name of the run.
              className={cn(
                "w-full rounded-[9px] border border-line bg-solid px-3 py-2",
                "text-sm text-text placeholder:text-faint",
              )}
            />
            {/* One button, two jobs, and it says which one it is doing.
                Browsing can only open a real picker in the desktop app: a
                browser's directory picker hands back a handle, not a path, and
                the backend needs a path it can resolve and contain (§16.2). So
                in a browser it is disabled and says why, rather than opening
                something that cannot finish. */}
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              disabled={checking || (browsing && !canBrowse)}
              title={
                browsing && !canBrowse
                  ? strings.workspace.browserOnly
                  : undefined
              }
              onClick={() => (browsing ? void pick() : void choose(path))}
            >
              {checking
                ? strings.workspace.checking
                : browsing
                  ? strings.workspace.browse
                  : strings.workspace.use}
            </Button>
          </div>

          {browsing && !canBrowse ? (
            <p className="text-[11px] text-faint">
              {strings.workspace.browserOnly}
            </p>
          ) : null}

          {error ? <p className="text-xs text-stop">{error}</p> : null}
        </div>
      )}
    </div>
  );
}

/** The one-line form shown while a mission runs: where, at a glance. */
export function WorkspaceBanner({ path }: { path: string | null }) {
  if (!path) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-solid px-3 py-1.5">
      <span className="shrink-0 text-[11px] text-faint">
        {strings.workspace.working}
      </span>
      <code className="min-w-0 flex-1 truncate text-xs text-done" title={path}>
        {path}
      </code>
    </div>
  );
}
