/**
 * The three columns (§18.2).
 *
 * The old shell put five tabs in a row and treated them as equals, which they
 * are not: Roster, Teams and Providers are settings — touched when something
 * changes, then left alone — while Chat, Mission and History were the work
 * itself. Mixing them meant the thing you do every day was one click among five
 * things you do rarely.
 *
 * So: past work down the left, the run you are looking at in the middle, and
 * what needs you on the right. Settings moved out of the row entirely.
 *
 * The glass rule lives here and is not negotiable: these three shells are
 * translucent, and everything inside them sits on `surface`, which is opaque.
 * Text on a blurred backdrop has a contrast ratio that depends on what happens
 * to be behind it, and that is not a thing anyone can promise.
 */
import type { ReactNode } from "react";
import { strings } from "../../lib/constants/strings.en";
import { ResizeHandle } from "../../components/ui/ResizeHandle";
import {
  MAX_WIDTH,
  MIN_WIDTH,
  usePanelStore,
  usePanelWidth,
} from "../../stores/panelStore";

export function AppShell({
  sidebar,
  main,
  aside,
}: {
  sidebar: ReactNode;
  main: ReactNode;
  aside: ReactNode;
}) {
  const mode = usePanelStore((s) => s.mode);
  const setWidth = usePanelStore((s) => s.setWidth);
  const width = usePanelWidth();

  return (
    // No panels. All three columns were floating glass boxes inset from the
    // window edges, which spent the outer padding, two 10px gaps and six
    // rounded corners to say "these are separate things" about columns that
    // never move and never overlap. Position already says it; a hairline is
    // enough to draw the seam.
    //
    // The rail lost its box with the middle rather than after it. A floating
    // panel between two flush columns reads as a mistake, not as emphasis —
    // so the choice was all three or none.
    //
    // `panel` still exists in index.css for anything that genuinely floats
    // above the page later. Nothing uses it today.
    //
    // `h-full w-full`, never `h-screen w-screen`: `100vw` includes the vertical
    // scrollbar, so the shell came out exactly one scrollbar wider than the
    // space it had. That produced a horizontal scrollbar, which stole 10px of
    // height, which made `100vh` taller than the visible area as well. One
    // wrong unit, both axes.
    <div className="flex h-full w-full overflow-hidden">
      <aside className="flex min-h-0 w-[262px] shrink-0 flex-col overflow-hidden border-r border-line">
        {sidebar}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {main}
      </main>

      {/* Closed entirely when nothing is selected — the work area then gets the
          whole window, which is the point of making it a panel you summon
          rather than a column that is always there.
          
          And closed on the pages it has nothing to say about: both things it
          can hold — the terminal and the run summary — belong to a mission, and
          Roster, Teams and Settings have none. `App` passes no aside there, so
          the choice stays remembered and comes back with the run rather than
          being switched off and needing to be found again. */}
      {mode && aside ? (
        <>
          <ResizeHandle
            width={width}
            min={MIN_WIDTH}
            max={MAX_WIDTH}
            onResize={(next) => setWidth(mode, next)}
            label={strings.rail.resize}
            hint={strings.rail.resizeHint}
          />
          <aside
            style={{ width: `${width}px` }}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-line"
          >
            {aside}
          </aside>
        </>
      ) : null}
    </div>
  );
}
