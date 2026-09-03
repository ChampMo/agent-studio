/**
 * What this run did to the files (§12 M6).
 *
 * It used to be a flat list of artifacts, and for most of this app's life that
 * list had exactly one thing in it — `final-answer.md`, because that was the
 * only place in the codebase that published `artifact.created`. A workspace
 * with twenty files in it showed "Files 0".
 *
 * Now that an agent's writes are recorded, a flat list would still answer the
 * least interesting question. *Which files exist* is what a file manager is
 * for, and the workspace chip opens one. What the app knows and it does not is
 * **who changed what, when, and in which order** — three agents touching one
 * stylesheet across two rounds is one file and one timestamp to the filesystem.
 *
 * So the list is the run's file history, derived from the log (§2.1), and the
 * content is fetched only when something is opened. The path shown is the one
 * on the row, and the backend resolves it inside the mission's own workspace —
 * the viewer cannot be turned into a file browser by a crafted path.
 */
import { useEffect, useMemo, useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/format";
import { useEventStore } from "../../stores/eventStore";
import { useHistoryStore } from "../../stores/historyStore";
import { useMissionStore } from "../../stores/missionStore";
import { api, type FileVersion } from "../../transport/rest";
import { fileTrails, type FileTrail } from "./fileHistory";
import { DiffView } from "./DiffView";

export function ArtifactViewer() {
  const events = useEventStore((s) => s.events);
  const nameOf = useMissionStore((s) => s.nameOf);
  const roster = useMissionStore((s) => s.roster);
  const missionId = useMissionStore((s) => s.missionId);
  const artifacts = useHistoryStore((s) => s.artifacts);
  const open = useHistoryStore((s) => s.open);
  const openArtifact = useHistoryStore((s) => s.openArtifact);
  const closeArtifact = useHistoryStore((s) => s.closeArtifact);

  // `roster` is in the dependencies as well as `nameOf`: that is a store action
  // whose identity never changes, so depending on it alone hands back rows
  // built before the roster arrived — a trap this codebase has now hit three
  // times.
  const trails = useMemo(() => fileTrails(events, nameOf), [events, nameOf, roster]);

  //: Anything the app wrote itself — the final answer — that is not a file in
  //: the workspace and so has no change history to show.
  const produced = artifacts.filter((a) => a.source !== "workspace");

  if (trails.length === 0 && produced.length === 0) {
    // Said, not hidden: a run that produced nothing is a real outcome, and an
    // empty panel would read as a loading state.
    return <p className="text-xs text-faint">{strings.artifacts.none}</p>;
  }

  const idFor = (path: string) =>
    artifacts.find((a) => a.source === "workspace" && a.path === path)?.id ?? null;

  return (
    <div className="space-y-4">
      {trails.length > 0 ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted">
            {strings.artifacts.changed(trails.length)}
          </h3>
          <ul className="space-y-1">
            {trails.map((trail) => (
              <TrailRow
                key={trail.path}
                trail={trail}
                artifactId={idFor(trail.path)}
                onOpen={openArtifact}
                missionId={missionId}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {produced.length > 0 ? (
        <section className="space-y-1.5">
          {/* The run's own answer, which the app wrote rather than an agent —
              so it has no change history and does not belong in the list
              above. */}
          <h3 className="text-xs font-medium text-muted">{strings.artifacts.title}</h3>
          <ul className="space-y-1">
            {produced.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  onClick={() => void openArtifact(artifact.id)}
                  className={cn(
                    "flex w-full min-h-[24px] items-center gap-2 rounded-card px-2 py-1.5",
                    "text-left text-xs text-muted hover:bg-solid hover:text-text",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                  <span className="shrink-0 text-[11px] text-faint tabular-nums">
                    {size(artifact.bytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open ? (
        <div className="space-y-2 rounded-[9px] border border-line bg-solid-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-faint">{open.path}</span>
            <button
              type="button"
              onClick={closeArtifact}
              className="min-h-[24px] rounded-card px-2 py-1 text-xs text-muted hover:bg-solid hover:text-text"
            >
              {strings.artifacts.close}
            </button>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs text-text">
            {open.text}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The difference one change made, fetched when asked for.
 *
 * Matched to the change by *position*: the nth successful write of a path made
 * the nth version of it. Both come off the same log in the same order, so
 * counting is enough — and it needs no new id on either side.
 *
 * A run recorded before versions were kept has none, and says so. There is
 * nothing to reconstruct: the content was never anywhere (§8).
 */
function ChangeDiff({
  missionId,
  path,
  nth,
}: {
  missionId: string | null;
  path: string;
  nth: number;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<FileVersion[] | null>(null);

  useEffect(() => {
    if (!open || versions || !missionId) return;
    void api
      .fileVersions(missionId, path)
      .then((r) => setVersions(r.versions))
      .catch(() => setVersions([]));
  }, [open, versions, missionId, path]);

  const version = versions?.[nth] ?? null;
  return (
    <div className="pt-0.5">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="min-h-[24px] rounded-card px-1 py-0.5 text-[11px] text-faint hover:bg-solid hover:text-muted"
      >
        {open ? "▾ " : "▸ "}
        {strings.artifacts.showDiff}
      </button>
      {open ? (
        versions === null ? (
          <p className="px-1 text-[11px] text-faint">{strings.artifacts.loading}</p>
        ) : version ? (
          <div className="mt-1">
            <DiffView version={version} previous={versions[nth - 1] ?? null} />
          </div>
        ) : (
          <p className="px-1 text-[11px] text-faint">{strings.artifacts.noVersions}</p>
        )
      ) : null}
    </div>
  );
}

function TrailRow({
  trail,
  artifactId,
  onOpen,
  missionId,
}: {
  trail: FileTrail;
  artifactId: string | null;
  onOpen: (id: string) => Promise<void> | void;
  missionId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const last = trail.changes[trail.changes.length - 1];

  return (
    <li className="rounded-[9px] bg-solid-2">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((was) => !was)}
          aria-expanded={expanded}
          className="flex min-h-[24px] min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            className={cn(
              "inline-block w-2 shrink-0 text-faint transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          >
            ›
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-xs",
              // A path that is not on disk is not the same as one that is, and
              // the difference is invisible in a plain list.
              trail.exists ? "text-text" : "text-stop line-through",
            )}
          >
            {trail.path}
          </span>
          <span className="shrink-0 text-[11px] text-faint">
            {strings.artifacts.changes(trail.changes.length)}
          </span>
        </button>
        {artifactId && trail.exists ? (
          <button
            type="button"
            onClick={() => void onOpen(artifactId)}
            className="min-h-[24px] shrink-0 rounded-card px-2 py-1 text-[11px] text-muted hover:bg-solid hover:text-text"
          >
            {strings.artifacts.open}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <ol className="ml-4 border-l border-line pl-3 pr-2 pb-2">
          {trail.changes.map((change, index) => (
            <li key={change.id} className="py-0.5 text-[11px] leading-snug">
              <div className="flex items-baseline gap-2">
                <span className={change.ok ? "text-muted" : "text-stop"}>
                  {change.summary}
                </span>
                <span className="ml-auto shrink-0 text-faint">
                  {change.name}
                  {change.ts ? ` · ${formatTime(new Date(change.ts))}` : ""}
                </span>
              </div>
              {/* Only for a write that worked. A failed one changed nothing,
                  so there is no difference to show. */}
              {change.ok ? (
                <ChangeDiff
                  missionId={missionId}
                  path={trail.path}
                  nth={index}
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        last ? (
          <p className="truncate px-2 pb-1.5 pl-6 text-[11px] text-faint">
            {last.summary}
            {last.name ? ` · ${last.name}` : ""}
          </p>
        ) : null
      )}
    </li>
  );
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
