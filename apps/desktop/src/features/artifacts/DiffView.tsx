/**
 * What one change did to a file.
 *
 * The Files tab could say *who* changed a file and *when* off the log alone.
 * It could not say **what**, because the content was never on the log and never
 * should be — `write_file.content` is redacted before the event is built, since
 * `mission_events` is append-only for ever. So the bytes live on disk,
 * content-addressed, and this fetches two of them and shows the difference.
 *
 * Two gutters, because a diff has two files in it. The left number is where the
 * line was, the right is where it is, and a line that only exists on one side
 * has a number on one side. That is the whole reason a diff is read with two
 * columns rather than one.
 *
 * Unchanged runs are skipped and **counted**, never merely dropped: the same
 * rule the activity fold follows, and for the same reason — a reader has to be
 * able to see that something was left out or they cannot trust what was kept.
 */
import { useEffect, useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { api, type FileVersion } from "../../transport/rest";
import { diffLines, hunks, type DiffLine } from "./diff";

type State =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; before: string; after: string };

export function DiffView({
  version,
  previous,
}: {
  version: FileVersion;
  /** Null for the first version of a file: it was created, so everything in it
   *  is an addition and there is nothing to compare against. */
  previous: FileVersion | null;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    void Promise.all([
      api.readFileVersion(version.id),
      previous ? api.readFileVersion(previous.id) : Promise.resolve(null),
    ])
      .then(([now, was]) => {
        if (!alive) return;
        setState({ phase: "ready", before: was?.text ?? "", after: now.text });
      })
      .catch((err: { message?: string }) => {
        if (!alive) return;
        // The row can outlive the blob — the data folder was cleaned, or the
        // file was removed. Said plainly rather than as a blank panel.
        setState({ phase: "failed", message: err?.message ?? String(err) });
      });
    return () => {
      alive = false;
    };
  }, [version.id, previous?.id]);

  if (state.phase === "loading") {
    return <p className="px-2 py-1 text-[11px] text-faint">{strings.artifacts.loading}</p>;
  }
  if (state.phase === "failed") {
    return <p className="px-2 py-1 text-[11px] text-stop">{state.message}</p>;
  }

  const parts = hunks(diffLines(state.before, state.after));
  if (parts.length === 0) {
    // A write that changed nothing is a real outcome — an agent rewriting a
    // file with the same bytes — and worth saying rather than showing blank.
    return <p className="px-2 py-1 text-[11px] text-faint">{strings.artifacts.noChange}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-[9px] border border-line bg-solid">
      <table className="w-full border-collapse font-mono text-[11px] leading-[1.6]">
        <tbody>
          {parts.map((hunk, index) => (
            <Hunk key={index} lines={hunk.lines} skipped={hunk.skipped} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hunk({ lines, skipped }: { lines: DiffLine[]; skipped: number }) {
  return (
    <>
      {skipped > 0 ? (
        <tr>
          <td colSpan={4} className="bg-solid-2 px-2 py-0.5 text-[10px] text-faint">
            {strings.artifacts.skipped(skipped)}
          </td>
        </tr>
      ) : null}
      {lines.map((line, index) => (
        <tr
          key={index}
          className={cn(
            line.kind === "added" && "bg-done/10",
            line.kind === "removed" && "bg-stop/10",
          )}
        >
          {/* Two gutters: where it was, where it is. `select-none` so copying
              the diff copies the code and not the line numbers with it. */}
          <td className="w-10 select-none border-r border-line px-1.5 text-right text-faint tabular-nums">
            {line.before ?? ""}
          </td>
          <td className="w-10 select-none border-r border-line px-1.5 text-right text-faint tabular-nums">
            {line.after ?? ""}
          </td>
          <td
            className={cn(
              "w-4 select-none text-center",
              line.kind === "added" && "text-done",
              line.kind === "removed" && "text-stop",
            )}
          >
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
          </td>
          <td className="whitespace-pre-wrap break-words px-2 text-text">
            {line.text || " "}
          </td>
        </tr>
      ))}
    </>
  );
}
