/**
 * A terminal on the run's workspace (§2.7).
 *
 * One command per turn, no pseudo-terminal — so no `vim`, nothing that prompts,
 * and no Ctrl-C into something already running. What it does give is the thing
 * people actually want beside a run: look at what the agents changed, and
 * change it yourself.
 *
 * Three facts are on screen rather than in a doc, because each one would
 * otherwise be discovered the hard way:
 *
 * * this is **you**, so the approval gate does not apply;
 * * it is **not in the mission record**, so nothing typed here appears on the
 *   timeline;
 * * what you change, **the agents see** on the next round.
 *
 * Scrollback lives in this component and dies with it. That is deliberate:
 * keeping it would mean either a table (a second record of the run that is not
 * the log, §2.1) or memory that grows for the life of the window.
 */
import { useEffect, useRef, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { api } from "../../transport/rest";
import { useMissionStore } from "../../stores/missionStore";

interface Entry {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export function TerminalPanel() {
  const missionId = useMissionStore((s) => s.missionId);
  const workspaceRoot = useMissionStore((s) => s.workspaceRoot);

  const [cwd, setCwd] = useState<string | null>(null);
  const [history, setHistory] = useState<Entry[]>([]);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Up/Down through what was typed before, newest first. */
  const [recall, setRecall] = useState<number | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // A run opened from history has a workspace on its row; use it as the
    // starting directory until the shell reports one of its own.
    setCwd(workspaceRoot);
    setHistory([]);
    setRecall(null);
  }, [missionId, workspaceRoot]);

  useEffect(() => {
    // Newest output at the bottom, always — unlike the transcript, nobody
    // reads a terminal by scrolling up while it works.
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [history, running]);

  const run = async (raw: string) => {
    const text = raw.trim();
    if (!text || !missionId || running) return;

    // `clear` never reaches the backend: it is about this panel, not the shell.
    if (text === "clear" || text === "cls") {
      setHistory([]);
      setCommand("");
      setRecall(null);
      return;
    }

    setRunning(true);
    setError(null);
    setCommand("");
    setRecall(null);
    try {
      const result = await api.runCommand(missionId, { command: text, cwd });
      setCwd(result.cwd);
      setHistory((past) => [
        ...past,
        // `startedIn`, not `cwd`: the line above the output should say where
        // the command ran, and `result.cwd` is where the shell *ended up*.
        // Spreading result last would have silently overwritten it.
        { ...result, command: text, cwd: cwd ?? result.cwd },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      input.current?.focus();
    }
  };

  if (!missionId) {
    return <p className="p-4 text-xs text-faint">{strings.terminal.noRun}</p>;
  }
  if (!workspaceRoot) {
    // No folder means nowhere to open. Said plainly rather than showing a
    // prompt that refuses every command.
    return <p className="p-4 text-xs text-faint">{strings.terminal.noWorkspace}</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 px-4 pt-3 pb-2 text-[11px] leading-snug text-faint">
        {strings.terminal.preamble}
      </p>

      {/* One scrolling column, top aligned: what has happened, then the prompt
          at the end of it. The prompt used to be a bar pinned to the bottom of
          the panel, which put it below a large empty space and read as a chat
          composer. A shell you have just opened shows a prompt at the top of an
          empty screen and fills downward. */}
      <div
        ref={scroller}
        onClick={() => input.current?.focus()}
        className="min-h-0 flex-1 cursor-text overflow-y-auto px-4 pb-4"
      >
        <div className="space-y-3 font-mono text-xs leading-relaxed">
          {history.map((entry, i) => (
            <div key={i} className="space-y-1">
              <div className="flex gap-2">
                <span className="shrink-0 text-accent">$</span>
                <span className="min-w-0 break-all text-text">{entry.command}</span>
              </div>

              {entry.stdout ? (
                <pre className="whitespace-pre-wrap break-words text-muted">
                  {entry.stdout}
                </pre>
              ) : null}
              {entry.stderr ? (
                <pre className="whitespace-pre-wrap break-words text-stop">
                  {entry.stderr}
                </pre>
              ) : null}

              {/* The exit code is only worth a line when it is not zero, or
                  when there was no output to speak for itself. */}
              {entry.timedOut || entry.exitCode !== 0 || !entry.stdout ? (
                <div className="text-[11px] text-faint">
                  {entry.timedOut
                    ? strings.terminal.timedOut
                    : strings.terminal.exit(entry.exitCode, entry.durationMs)}
                  {entry.truncated ? ` · ${strings.terminal.truncated}` : ""}
                </div>
              ) : null}
            </div>
          ))}

          {running ? (
            <div className="text-[11px] text-faint">{strings.terminal.running}</div>
          ) : null}
          {error ? <div className="text-[11px] text-stop">{error}</div> : null}

          {/* The live prompt, in the flow rather than under it. */}
          <div className="flex items-center gap-2">
            <label htmlFor="terminal-input" className="sr-only">
              {strings.terminal.label}
            </label>
            {/* The directory, not a fake hostname. It is the one piece of
                prompt that carries information, and `cd` moves it. */}
            <span className="min-w-0 shrink truncate text-faint" title={cwd ?? ""}>
              {shorten(cwd, workspaceRoot)}
            </span>
            <span className="shrink-0 text-accent">$</span>
            <input
              id="terminal-input"
              ref={input}
              value={command}
              spellCheck={false}
              autoComplete="off"
              disabled={running}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void run(event.currentTarget.value);
                  return;
                }
                // Up and Down walk what was typed before. The one shell
                // affordance whose absence is felt immediately.
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  if (history.length === 0) return;
                  event.preventDefault();
                  const next =
                    event.key === "ArrowUp"
                      ? Math.min((recall ?? -1) + 1, history.length - 1)
                      : (recall ?? 0) - 1;
                  if (next < 0) {
                    setRecall(null);
                    setCommand("");
                    return;
                  }
                  setRecall(next);
                  setCommand(history[history.length - 1 - next]!.command);
                }
              }}
              placeholder={strings.terminal.placeholder}
              className={cn(
                "min-w-0 flex-1 border-none bg-transparent p-0 text-xs text-text",
                "placeholder:text-faint focus:outline-none disabled:opacity-50",
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The path relative to the workspace, so the prompt does not spend its width
 *  repeating a folder you already chose. Absolute once you leave it, because
 *  then *where* is the whole point. */
function shorten(cwd: string | null, root: string | null): string {
  if (!cwd) return "";
  if (!root) return cwd;
  const a = cwd.replace(/\\/g, "/");
  const b = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (a === b) return "~";
  if (a.toLowerCase().startsWith(b.toLowerCase() + "/")) {
    return "~/" + a.slice(b.length + 1);
  }
  return a;
}
