/**
 * The right-hand panel: whichever thing you summoned (§18.2).
 *
 * It used to be one fixed column called "This run", always present, holding the
 * approval card, the members and the budget. Two things changed that.
 *
 * The question moved into the transcript, where the context that explains it
 * already is — so the panel no longer has to be visible at all times for a
 * paused mission to be answerable. That was the whole reason it could not be
 * given up.
 *
 * And the terminal needed room. It lives here now, and the panel is wider when
 * it is showing, because 80 columns of monospace do not fit in a column sized
 * for short rows of text.
 *
 * So the panel is summoned rather than permanent: two buttons in the mission
 * header choose what it holds, and pressing the lit one closes it and gives the
 * whole window back to the work.
 */
import { strings } from "../../lib/constants/strings.en";
import { useMissionStore } from "../../stores/missionStore";
import { usePanelStore } from "../../stores/panelStore";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { RunVitals } from "./RunVitals";
import { PlanProgress } from "./PlanProgress";
import { useVitals } from "./useVitals";

export function RightPanel() {
  const mode = usePanelStore((s) => s.mode);

  if (mode === "terminal") return <TerminalPanel />;
  if (mode === "run") return <RunSummary />;
  return null;
}

function RunSummary() {
  const roster = useMissionStore((s) => s.roster);
  const missionId = useMissionStore((s) => s.missionId);
  const vitals = useVitals();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {/* No heading. The button that opened this panel is lit and says "This
          run", and the breadcrumb above says which — a title here would be the
          third thing saying it. */}
      {missionId ? (
        <>
          <PlanProgress />
          <RunVitals roster={roster} vitals={vitals} />
        </>
      ) : (
        <p className="px-1 text-xs text-faint">{strings.rail.empty}</p>
      )}
    </div>
  );
}
