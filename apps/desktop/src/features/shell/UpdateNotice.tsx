/**
 * One row in the sidebar, and only when there is something to say.
 *
 * An update is not a place you go, so it is not one of the three rows below
 * it. It is a thing that is either waiting or not — which is why this renders
 * nothing at all in the ordinary case rather than a permanently present
 * "Up to date" that teaches people to stop reading the bottom of the column.
 * The same argument that took `open_desks` off the team cards: a line that
 * says the same thing every day is a line nobody sees on the day it changes.
 *
 * It does not check. `App` does that once for the life of the window, so the
 * capability does not disappear with a component again (§12 M10) — and the
 * panel in Settings is where the check can be repeated by hand.
 *
 * Pressing it starts the download. It does not open Settings first: the whole
 * point is one step, and the account of what is happening appears here as it
 * happens rather than somewhere else.
 */
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useUpdateStore } from "../../stores/updateStore";

export function UpdateNotice() {
  const stage = useUpdateStore((s) => s.stage);
  const offered = useUpdateStore((s) => s.offered);
  const received = useUpdateStore((s) => s.received);
  const total = useUpdateStore((s) => s.total);
  const install = useUpdateStore((s) => s.install);
  const restart = useUpdateStore((s) => s.restart);

  // Nothing waiting, nothing running, nothing to report. A failed check is
  // silent here too: being unable to reach GitHub is not news to somebody who
  // did not ask, and Settings carries the endpoint's words for anyone who did.
  if (stage === "downloading") {
    return (
      <Row busy>
        {total
          ? strings.update.downloading(
              formatBytes(received),
              formatBytes(total),
            )
          : formatBytes(received)}
      </Row>
    );
  }
  if (stage === "ready") {
    return (
      <Row onClick={() => void restart()} accent>
        {strings.update.bannerReady}
      </Row>
    );
  }
  if (stage !== "available" || !offered) return null;

  return (
    <Row onClick={() => void install()} accent>
      {strings.update.banner(offered)}
    </Row>
  );
}

function Row({
  children,
  onClick,
  accent,
  busy,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  accent?: boolean;
  busy?: boolean;
}) {
  const className = cn(
    "flex w-full items-center gap-2.5 rounded-card px-2.5 py-2 text-left text-sm",
    accent ? "text-accent hover:bg-solid-2" : "text-muted",
  );
  const dot = (
    <span aria-hidden="true" className="shrink-0">
      {/* The same fish the transcript and the boot screen use while something
          is working, and a dot in the accent colour while something is only
          waiting to be started. One drawing per meaning. */}
      {busy ? (
        <span className="fish-loader" />
      ) : (
        <span className="ml-1.5 block size-2 rounded-full bg-accent" />
      )}
    </span>
  );

  if (!onClick) {
    return (
      <div className={className} role="status">
        {dot}
        <span className="truncate">{children}</span>
      </div>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {dot}
      <span className="truncate">{children}</span>
    </button>
  );
}
