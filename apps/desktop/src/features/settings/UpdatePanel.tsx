/**
 * Updates, in the one place where what they are is explained.
 *
 * The sidebar row (`UpdateNotice`) is the offer; this is the account of it:
 * what is installed, when the endpoint was last asked, what it said, and the
 * sentence that makes the whole mechanism trustworthy — a bundle is verified
 * against a key built into this copy before anything is written.
 *
 * Both read one store, so the row and the page cannot disagree about whether
 * an update is waiting (§2.1).
 *
 * **"Last asked", not "up to date".** A panel that says up to date is making a
 * claim about the present that it stopped being able to support the moment the
 * check returned. The same rule the search-allowance meter is under: a reading
 * is of a moment, and saying which moment is what keeps it honest.
 */
import { strings } from "../../lib/constants/strings.en";
import { formatBytes, formatDateTime } from "../../lib/format";
import { Button } from "../../components/ui/primitives";
import { useUpdateStore } from "../../stores/updateStore";

export function UpdatePanel() {
  const {
    stage,
    installed,
    offered,
    notes,
    published,
    received,
    total,
    error,
    checkedAt,
  } = useUpdateStore();
  const check = useUpdateStore((s) => s.check);
  const install = useUpdateStore((s) => s.install);
  const restart = useUpdateStore((s) => s.restart);

  const busy = stage === "checking" || stage === "downloading";

  return (
    <div className="space-y-4 pt-1">
      <p className="max-w-2xl text-xs text-muted">{strings.update.signed}</p>

      <div className="space-y-1">
        <p className="text-sm text-text">
          {installed
            ? strings.update.installed(installed)
            : strings.update.unknownVersion}
        </p>
        {/* Never asked and asked-and-told-nothing are different facts, so they
            get different sentences rather than one hedged one. */}
        <p className="text-xs text-faint">
          {checkedAt
            ? strings.update.checkedAt(formatDateTime(new Date(checkedAt)))
            : strings.update.neverChecked}
        </p>
      </div>

      {stage === "unsupported" ? (
        <p className="text-xs text-muted">{strings.update.unsupported}</p>
      ) : null}

      {stage === "current" ? (
        <p className="text-sm text-muted">{strings.update.current}</p>
      ) : null}

      {offered && (stage === "available" || stage === "downloading") ? (
        <div className="space-y-2 rounded-[9px] border border-line bg-solid/40 p-4">
          <p className="text-sm font-medium text-text">
            {strings.update.available(offered)}
          </p>
          {published ? (
            <p className="text-xs text-faint">
              {strings.update.published(formatDateTime(new Date(published)))}
            </p>
          ) : null}

          {/* The release's own words, unedited and not summarised: they belong
              to whoever wrote the release, and this app has no business
              rewriting them. `whitespace-pre-wrap` so the line breaks they
              chose survive. */}
          {notes ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted">
                {strings.update.notesTitle}
              </p>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-muted">
                {notes}
              </p>
            </div>
          ) : null}

          {stage === "downloading" ? (
            <div className="space-y-1.5">
              {/* A bar only where the server declared a length. Without one
                  there is no proportion to draw, and the bytes that did
                  arrive are the number that is true (§1.1). */}
              {total ? (
                <>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={received}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-solid-2"
                  >
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-150"
                      style={{
                        width: `${Math.min(100, (received / total) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted">
                    {strings.update.downloading(
                      formatBytes(received),
                      formatBytes(total),
                    )}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted">
                  {strings.update.downloadingUnsized(formatBytes(received))}
                </p>
              )}
            </div>
          ) : (
            <Button onClick={() => void install()}>
              {strings.update.install}
            </Button>
          )}
        </div>
      ) : null}

      {stage === "ready" ? (
        <div className="space-y-2 rounded-[9px] border border-line bg-solid/40 p-4">
          <p className="text-sm text-text">{strings.update.ready}</p>
          <Button onClick={() => void restart()}>
            {strings.update.restart}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-md bg-stop/10 px-3 py-2 text-xs text-stop">
          {strings.update.failed} {error}
        </p>
      ) : null}

      {stage === "unsupported" ? null : (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void check(true)}
        >
          {stage === "checking"
            ? strings.update.checking
            : strings.update.check}
        </Button>
      )}
    </div>
  );
}
