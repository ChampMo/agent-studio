/**
 * The working screen: scene on top, record below, composer at the bottom
 * (PROJECT_BRIEF.md §17.1).
 *
 * The scene used to be one panel among several. It is now always on screen,
 * with a draggable divider between it and the record of what happened — which
 * is the arrangement the app has really wanted since M5, because the scene and
 * the timeline are two views of the same events (§2.1) and reading one while
 * watching the other was impossible when they were in different places.
 *
 * Two consequences, both handled rather than hoped about:
 *
 * * The scene now runs even when nobody is looking at it, so it is told its own
 *   height and stops its ticker at zero (§12 M9 criterion 2).
 * * The divider is a real control, not a decoration: `role="separator"` with
 *   the full keyboard set, because a divider you can only drag is unusable
 *   without a mouse.
 */
import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { SplitPane } from "../../components/ui/SplitPane";
import { SceneView } from "../../scene/SceneView";
import { TimelinePanel } from "../timeline/TimelinePanel";
import { ArtifactViewer } from "../artifacts/ArtifactViewer";

type Pane = "timeline" | "artifacts";

export function WorkView({ composer }: { composer?: React.ReactNode }) {
  const [pane, setPane] = useState<Pane>("timeline");
  // The scene is told what it was given, so it can stop drawing when that is
  // nothing. Held here rather than read from the DOM, which would mean asking
  // for a layout on every frame.
  const [sceneHeight, setSceneHeight] = useState(280);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SplitPane
        label={strings.workview.splitter}
        defaultHeight={280}
        minHeight={0}
        onHeightChange={setSceneHeight}
        top={<SceneView heightPx={sceneHeight} />}
        bottom={
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              role="tablist"
              aria-label={strings.workview.recordTabs}
              className="flex shrink-0 gap-1 border-b border-slate-800 px-3 py-1.5"
            >
              {(["timeline", "artifacts"] as const).map((key) => (
                <button
                  key={key}
                  role="tab"
                  type="button"
                  aria-selected={pane === key}
                  onClick={() => setPane(key)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                    pane === key
                      ? "bg-slate-800 text-slate-100"
                      : "text-slate-400 hover:bg-slate-900 hover:text-slate-200",
                  )}
                >
                  {strings.workview[key]}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {pane === "timeline" ? (
                <TimelinePanel />
              ) : (
                <div className="p-4">
                  <ArtifactViewer />
                </div>
              )}
            </div>
          </div>
        }
      />

      {composer ? (
        <div className="shrink-0 border-t border-slate-800 p-3">{composer}</div>
      ) : null}
    </div>
  );
}
