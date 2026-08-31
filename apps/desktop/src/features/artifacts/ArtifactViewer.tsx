/**
 * What a mission left behind (PROJECT_BRIEF.md §12 M6).
 *
 * The list is metadata read from the database; the text is fetched only when
 * something is opened. The path shown is the one recorded on the row, and the
 * backend refuses to read outside the mission's own directory — the viewer
 * cannot be turned into a file browser by a crafted path.
 */
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { useHistoryStore } from "../../stores/historyStore";
import { Badge, Button } from "../../components/ui/primitives";

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function ArtifactViewer() {
  const artifacts = useHistoryStore((s) => s.artifacts);
  const open = useHistoryStore((s) => s.open);
  const openArtifact = useHistoryStore((s) => s.openArtifact);
  const closeArtifact = useHistoryStore((s) => s.closeArtifact);

  if (artifacts.length === 0) {
    // Said, not hidden: a run that produced nothing is a real outcome, and an
    // empty panel would read as a loading state.
    return <p className="text-xs text-slate-500">{strings.artifacts.none}</p>;
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {strings.artifacts.title}
      </h3>

      <div className="space-y-1">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            onClick={() => void openArtifact(artifact.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs",
              open?.id === artifact.id
                ? "border-sky-800 bg-sky-950/40 text-sky-100"
                : "border-slate-800 bg-slate-900/40 text-slate-300 hover:bg-slate-900",
            )}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
            <Badge>{artifact.kind}</Badge>
            <span className="shrink-0 text-slate-500">{size(artifact.bytes)}</span>
          </button>
        ))}
      </div>

      {open ? (
        <div className="space-y-2 rounded-md border border-slate-800 bg-slate-950/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-slate-500">{open.path}</span>
            <Button variant="ghost" onClick={closeArtifact}>
              {strings.artifacts.close}
            </Button>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
            {open.text}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
