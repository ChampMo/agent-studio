/**
 * Where this app keeps things (§9.3).
 *
 * The runs, the files agents produced and the pictures attached to them all
 * live in one folder that nothing on screen has ever named. "Where did my
 * files go" is a fair question and the answer was: read the source, or guess
 * from the platform.
 *
 * Sizes are measured rather than estimated, and a folder that does not exist
 * yet reports zero rather than being left out — "no artifacts yet" and "no such
 * thing" read very differently to someone looking for a missing file.
 *
 * The path is the useful part, so it opens: the same `reveal_folder` the
 * workspace chip uses, with the same honest fallback in a browser.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { FolderIcon } from "../../components/ui/icons";
import { revealFolder } from "../../lib/reveal";
import { api, type StoragePart } from "../../transport/rest";

/** Bytes as a person reads them. Never rounded up past a boundary: 999 bytes
 *  is not "1 KB". */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function StoragePanel() {
  const [root, setRoot] = useState<string | null>(null);
  const [parts, setParts] = useState<StoragePart[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    void api
      .storage()
      .then((r) => {
        setRoot(r.root);
        setParts(r.parts);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), 4000);
    return () => window.clearTimeout(timer);
  }, [said]);

  if (error) return <p className="text-xs text-stop">{error}</p>;
  if (!root) return <p className="text-xs text-faint">{strings.storage.loading}</p>;

  const total = parts.reduce((sum, part) => sum + part.bytes, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={strings.storage.open(root)}
          title={strings.storage.open(root)}
          onClick={async () => {
            const outcome = await revealFolder(root);
            setSaid(
              outcome.kind === "opened"
                ? strings.mission.workspaceOpened
                : outcome.kind === "copied"
                  ? strings.mission.workspaceCopied
                  : outcome.message,
            );
          }}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md border border-line bg-solid",
            "px-2.5 py-1 text-xs text-muted transition-colors",
            "hover:border-line-strong hover:text-text",
          )}
        >
          <FolderIcon />
          <code className="max-w-[26rem] truncate font-mono text-[11px]">{root}</code>
        </button>
        <span role="status" aria-live="polite" className="text-[11px] text-faint">
          {said}
        </span>
      </div>

      <div className="divide-y divide-line border-y border-line">
        {parts.map((part) => (
          <div key={part.id} className="flex items-baseline gap-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-text">{part.label}</div>
              <div className="truncate font-mono text-[11px] text-faint">
                {part.path}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm tabular-nums text-text">{size(part.bytes)}</div>
              <div className="text-[11px] tabular-nums text-faint">
                {part.exists
                  ? strings.storage.files(part.files)
                  : strings.storage.notYet}
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-faint">
        {strings.storage.total(size(total))}
      </p>
    </div>
  );
}
