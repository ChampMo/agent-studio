/**
 * The middle column: the run you are looking at (§18.2).
 *
 * The header is deliberately small. A goal is a sentence, not a page title, and
 * setting it in 30px pushed the thing that matters — what is happening now —
 * below the fold. It is 17px, under a breadcrumb that says which team, above a
 * row of chips carrying the facts a person checks at a glance.
 *
 * The workspace chip is in that row and never leaves it while a run is open. It
 * is not decoration: it is the boundary of what the agents may touch (§16.2),
 * and a boundary you cannot see is one you cannot check.
 *
 * Below that the column is split rather than tabbed. The scene is not one view
 * among three — it is what the run *looks* like, and it stays on screen while
 * you read the record underneath it. The two are different questions about the
 * same moment ("who is doing what" and "what exactly happened"), so putting
 * them behind one tab bar meant answering either one cost you the other. The
 * divider is where the trade lives now, and it is the person's to make: drag it
 * to nothing when the log is what matters, drag it up when the room is.
 *
 * What stays tabbed is the record, because Timeline and Files really are two
 * views of one thing and nobody needs both at once.
 */
import { useEffect, useMemo, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { revealFolder } from "../../lib/reveal";
import { cn } from "../../lib/cn";
import { useEventStore } from "../../stores/eventStore";
import { useHistoryStore } from "../../stores/historyStore";
import { useMissionStore } from "../../stores/missionStore";
import { RunTitle } from "./RunTitle";
import { useEndLimit, useEndReason } from "../../stores/runState";
import { useTeamStore } from "../../stores/teamStore";
import { StatusMark } from "../../components/ui/StatusMark";
import { missionLook } from "../../components/ui/status";
import { SplitPane } from "../../components/ui/SplitPane";
import { SceneView } from "../../scene/SceneView";
import { TimelinePanel } from "../timeline/TimelinePanel";
import { FolderIcon, PanelIcon, TerminalIcon } from "../../components/ui/icons";
import { usePanelStore, type PanelMode } from "../../stores/panelStore";
import { ArtifactViewer } from "../artifacts/ArtifactViewer";
import { fileTrails } from "../artifacts/fileHistory";
import { Composer } from "./Composer";
import { UnfinishedWork } from "../shell/UnfinishedWork";

type Record = "timeline" | "artifacts";

export function MissionView() {
  const missionId = useMissionStore((s) => s.missionId);
  const draft = useMissionStore((s) => s.draft);
  const kind = useMissionStore((s) => s.kind);
  const teamId = useMissionStore((s) => s.teamId);
  //: From the log first, the row second. The row is read once and never
  //: updated, so on its own it reports a finished run as still working.
  const endReason = useEndReason();
  const endLimit = useEndLimit();
  const workspaceRoot = useMissionStore((s) => s.workspaceRoot);
  const teams = useTeamStore((s) => s.teams);
  const events = useEventStore((s) => s.events);
  const replaying = useEventStore((s) => s.replaying);
  const artifacts = useHistoryStore((s) => s.artifacts);
  const nameOf = useMissionStore((s) => s.nameOf);
  //: Subscribed as well as depended on: `nameOf` is a store action whose
  //: identity never changes, so the roster has to be in the dependencies or
  //: the trails are built from names that had not arrived yet.
  const roster = useMissionStore((s) => s.roster);
  const refreshArtifacts = useHistoryStore((s) => s.refreshArtifacts);
  const [record, setRecord] = useState<Record>("timeline");
  // The scene's own height, so its ticker can stop when the divider shuts it
  // rather than animating something nobody can see (§17.1).
  const [sceneHeight, setSceneHeight] = useState(280);

  const running = missionId !== null && endReason === null;
  //: A draft is not a state the backend has an opinion about — it does not
  //: know this run exists — so it is named here rather than pulled from a
  //: status that has never been written.
  const look = draft
    ? {
        shape: "ring" as const,
        tone: "idle" as const,
        label: strings.mission.notStarted,
      }
    : missionLook(running ? "running" : "ended", endReason, endLimit);

  // One row per task, latest state wins. Counted, never a percentage: no
  // honest percentage of agent work exists (§15 row 7).
  const progress = useMemo(() => {
    const byId = new Map<string, { state: string; total: number }>();
    for (const { event } of events) {
      if (event.draft.type !== "mission.progress") continue;
      const p = event.draft.payload as unknown as {
        taskId: string;
        state: string;
        total: number;
      };
      byId.set(p.taskId, p);
    }
    const rows = [...byId.values()];
    return {
      done: rows.filter((r) => r.state === "done").length,
      total: rows[0]?.total ?? rows.length,
    };
  }, [events]);

  // Files the run has produced, counted off the log. `openMission` fetches the
  // list once, which is right for a finished run and leaves a live one saying
  // "Files 0" seconds after the timeline announced a file was written.
  const written = useMemo(
    () =>
      events.filter((e) => e.event.draft.type === "artifact.created").length,
    [events],
  );

  // The tab counts *files touched*, not artifacts. A run that wrote one file
  // four times has one file on that tab, and a run whose writes all failed has
  // rows worth reading and no artifacts at all — counting artifacts would say
  // "Files 0" over both.
  const touched = useMemo(
    () =>
      fileTrails(events, nameOf).length +
      artifacts.filter((a) => a.source !== "workspace").length,
    [events, nameOf, roster, artifacts],
  );

  useEffect(() => {
    if (missionId && written > artifacts.length)
      void refreshArtifacts(missionId);
  }, [missionId, written, artifacts.length, refreshArtifacts]);

  const where =
    kind === "chat"
      ? strings.mission.soloChat
      : (teams.find((t) => t.id === teamId)?.name ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 space-y-2.5 px-4 pb-3 pt-3.5">
        <nav
          aria-label={strings.mission.breadcrumb}
          className="text-xs text-faint"
        >
          {where ? (
            <>
              <span>{where}</span>
              <span className="px-1.5" aria-hidden="true">
                ›
              </span>
            </>
          ) : null}
          <span className="text-muted">{strings.mission.currentRun}</span>
        </nav>

        {/* The run's *title* — a name, not the paragraph the team was given.
            The instruction is the first message, in the transcript, where it
            was said, and it is not editable from anywhere. */}
        <RunTitle />

        <div className="flex flex-wrap items-center gap-2">
          <Chip>
            <StatusMark look={look} />
            <span>{look.label}</span>
          </Chip>

          {/* Here for as long as the run is open. This is the edge of what the
              agents may touch, and §16.2 is only checkable if it is visible. */}
          {workspaceRoot ? <WorkspaceChip path={workspaceRoot} /> : null}

          {progress.total > 0 ? (
            <Chip>
              {strings.mission.progress(progress.done, progress.total)}
            </Chip>
          ) : null}

          {/* A chip, not a banner over the scene: whether you are watching a
              live run or reading a record is a fact about the run, and it must
              not disappear when the scene is dragged shut. */}
          {replaying ? <Chip>{strings.history.replaying}</Chip> : null}

          {/* What the right-hand panel shows, chosen here because this is the
              run the panel is about. Pressing the lit one closes the panel and
              gives the whole window to the work. */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <PanelButton mode="terminal" label={strings.rail.showTerminal}>
              <TerminalIcon size={15} />
            </PanelButton>
            <PanelButton mode="run" label={strings.rail.showRun}>
              <PanelIcon size={15} />
            </PanelButton>
          </div>

          {/* Stopping lives on the composer's own button now, where the hands
              already are. Two stop controls on one screen is two places to look
              for the same thing, and the header's was the further one. */}
          {endReason && endReason !== "completed" ? (
            <span className="text-xs text-wait">
              {strings.mission.endedPrefix}: {endReason}
            </span>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden px-3 pb-1">
        {/* Content sits on the opaque surface, never on the glass (§18.1). */}
        <div className="surface flex h-full min-h-0 flex-col overflow-hidden">
          <SplitPane
            label={strings.workview.splitter}
            hint={strings.workview.splitterHint}
            onHeightChange={setSceneHeight}
            top={<SceneView heightPx={sceneHeight} />}
            bottom={
              <>
                <div
                  role="tablist"
                  aria-label={strings.workview.recordTabs}
                  className="flex shrink-0 gap-1 border-b border-line px-3"
                >
                  {(
                    [
                      ["timeline", strings.mission.viewTimeline, events.length],
                      ["artifacts", strings.mission.viewArtifacts, touched],
                    ] as const
                  ).map(([id, label, count]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={record === id}
                      onClick={() => setRecord(id)}
                      className={cn(
                        "-mb-px min-h-[24px] border-b-2 px-2.5 py-2 text-sm transition-colors",
                        record === id
                          ? "border-accent text-text"
                          : "border-transparent text-muted hover:text-text",
                      )}
                    >
                      {label}
                      {count === null ? null : (
                        <span className="ml-1.5 text-xs text-faint">
                          {count}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* The timeline scrolls itself — it has a sticky header of its
                    own — so the wrapper must not add a second scroll area. */}
                <div className="min-h-0 flex-1">
                  {record === "timeline" ? (
                    <TimelinePanel />
                  ) : (
                    <div className="h-full overflow-y-auto p-4">
                      <ArtifactViewer />
                    </div>
                  )}
                </div>
              </>
            }
          />
        </div>
      </div>

      {/* The splitter's keyboard instructions used to live here as a
          permanent line of text. They belong to the control, not to the page:
          the divider carries them as its `title` and its accessible name, so
          they are there when you reach for it and absent the rest of the
          time. */}
      {/* Above the box, outside the scroll. It is something to decide rather
          than something that happened, so it does not belong in the record —
          and the record is where it scrolls out of sight. */}
      <UnfinishedWork />
      <Composer />
    </div>
  );
}

/**
 * The workspace path, and the way to open it.
 *
 * A chip that only displays a path leaves one obvious thing undone — the folder
 * is right there and the only way in was to select the text. It opens the file
 * manager in the window, and copies the path in a browser, which cannot open
 * one. Both say which happened: a button that silently does one of two
 * different things is worse than one that does neither.
 *
 * The result is announced rather than only drawn, because "copied" and "opened"
 * are indistinguishable to anyone not looking at the taskbar.
 */
function WorkspaceChip({ path }: { path: string }) {
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), 4000);
    return () => window.clearTimeout(timer);
  }, [said]);

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        title={strings.mission.workspaceOpen(path)}
        aria-label={strings.mission.workspaceOpen(path)}
        onClick={async () => {
          const outcome = await revealFolder(path);
          setSaid(
            outcome.kind === "opened"
              ? strings.mission.workspaceOpened
              : outcome.kind === "copied"
                ? strings.mission.workspaceCopied
                : outcome.message,
          );
        }}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-line bg-solid",
          "px-2.5 py-1 text-xs text-muted transition-colors",
          "hover:border-line-strong hover:text-text",
        )}
      >
        <FolderIcon />
        <span className="text-faint">{strings.mission.workspaceChip}</span>
        <code className="max-w-[22rem] truncate font-mono text-[11px] text-muted">
          {path}
        </code>
      </button>
      {/* Polite: it follows a click the person made, so it does not need to
          interrupt whatever is being read. */}
      <span role="status" aria-live="polite" className="text-[11px] text-faint">
        {said}
      </span>
    </span>
  );
}

function Chip({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="flex items-center gap-1.5 rounded-md border border-line bg-solid px-2.5 py-1 text-xs text-muted"
    >
      {children}
    </span>
  );
}

/**
 * One of the two panel buttons.
 *
 * `aria-pressed` rather than a plain button: this is a toggle whose state is
 * the point, and a screen reader should say whether the panel is open without
 * the user having to go and find out.
 */
function PanelButton({
  mode,
  label,
  children,
}: {
  mode: PanelMode;
  label: string;
  children: React.ReactNode;
}) {
  const open = usePanelStore((s) => s.mode) === mode;
  const toggle = usePanelStore((s) => s.toggle);
  // A draft has no mission row yet, so there is no workspace to open a shell
  // in and no members to list. Disabled and saying why, rather than opening a
  // panel whose only content is an explanation of why it is empty.
  const started = useMissionStore((s) => s.missionId) !== null;

  return (
    <button
      type="button"
      onClick={() => toggle(mode)}
      disabled={!started}
      aria-pressed={open}
      aria-label={label}
      title={started ? label : strings.rail.beforeStart}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-card transition-colors",
        open
          ? "bg-solid-2 text-text"
          : "text-muted hover:bg-solid hover:text-text",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
