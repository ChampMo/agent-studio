/**
 * The app shell (§18.2).
 *
 * There is no tab row any more. It used to hold five things that were not
 * comparable — Roster, Teams and Providers are settings; Chat, Mission and
 * History were the work — so the thing done every day was one click among four
 * done rarely. Past runs are down the left now, the run in front of you is in
 * the middle, and what needs you is on the right. Settings is a place you go,
 * not a tab you pass.
 */
import { useEffect, useState } from "react";
import { apply, useThemeStore } from "./stores/themeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { OnboardingScreen } from "./features/settings/OnboardingScreen";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { RosterPanel } from "./features/roster/RosterPanel";
import { TeamsPanel } from "./features/teams/TeamsPanel";
import { MissionPanel } from "./features/mission/MissionPanel";
import { AppShell } from "./features/shell/AppShell";
import { BootScreen } from "./features/shell/BootScreen";
import { Sidebar, type SidebarPlace } from "./features/shell/Sidebar";
import { RightPanel } from "./features/shell/RightPanel";
import { useHistoryStore } from "./stores/historyStore";
import { useMissionStore } from "./stores/missionStore";
import { useApprovalStore } from "./stores/approvalStore";
import { useUpdateStore } from "./stores/updateStore";
import { sceneWindowMission } from "./lib/popout";
import { ScenePage } from "./scene/ScenePage";

export function App() {
  const ready = useSettingsStore((s) => s.ready);
  const loading = useSettingsStore((s) => s.loading);
  const needsOnboarding = useSettingsStore((s) => s.needsOnboarding());
  const waitForBackend = useSettingsStore((s) => s.waitForBackend);
  const [place, setPlace] = useState<SidebarPlace>("work");
  const closeMission = useHistoryStore((s) => s.closeMission);
  const refreshApprovals = useApprovalStore((s) => s.refresh);
  //: Both things the panel can hold belong to a mission that exists: the
  //: terminal runs in one's workspace, and "This run" is one's members and
  //: budget. A draft has neither yet — it has no row until the first message.
  const missionId = useMissionStore((s) => s.missionId);

  useEffect(() => {
    void waitForBackend();
  }, [waitForBackend]);

  // Stamped for the life of the window. Read from localStorage on the first
  // render rather than after the backend answers: waiting would show the
  // default theme for a second and then swap, which is the one thing a theme
  // setting must not do.
  const theme = useThemeStore((s) => s.choice);
  useEffect(() => {
    apply(theme);
  }, [theme]);

  // Asked once, here, because a question can outlive the process that asked it
  // (§12 M6) and nothing else in the app fetches it. It used to live on the
  // rail's approval card; deleting that card took the fetch with it, and a
  // question from a previous session had nowhere left to appear. Mounted for
  // the life of the window, so it cannot go missing again by moving a panel.
  useEffect(() => {
    if (ready) void refreshApprovals();
  }, [ready, refreshApprovals]);

  // Asked once for the life of the window, here for the same reason the line
  // above is: a capability that only one component performs disappears when
  // that component does, and the sidebar row deliberately renders nothing when
  // there is nothing waiting — so it can never be the thing that asks.
  //
  // Not gated on `ready`: whether this copy is out of date has nothing to do
  // with whether its backend came up, and the boot screen is exactly when
  // somebody is already waiting.
  const checkForUpdate = useUpdateStore((s) => s.check);
  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

  if (!ready) return <BootScreen />;

  // A window opened to show one room shows that room and nothing else. Read
  // once per window: the fact is set before any script runs and never changes.
  const sceneOnly = sceneWindowMission();
  if (sceneOnly) return <ScenePage missionId={sceneOnly} />;

  // No key anywhere means nothing else in the app can work, so onboarding is a
  // gate rather than a suggestion (§3.2).
  if (!loading && needsOnboarding) return <OnboardingScreen />;

  return (
  <AppShell
      sidebar={
        <Sidebar
          place={place}
          onGo={setPlace}
          onNewRun={() => {
            closeMission();
            setPlace("work");
          }}
        />
      }
      // Not on Roster, Teams or Settings — neither thing the panel holds means
      // anything beside them — and not before a run exists. An empty panel
      // saying "open a run to see who is on it" is a column of window spent on
      // an instruction; the buttons that would open it are disabled and say the
      // same thing in a tooltip, where it costs nothing.
      aside={place === "work" && missionId ? <RightPanel /> : null}
      main={
        place === "roster" ? (
          <RosterPanel />
        ) : place === "teams" ? (
          <TeamsPanel />
        ) : place === "settings" ? (
          // No wrapper scroller: Settings has its own section rail beside a
          // scrolling pane, and an outer one would scroll the rail away.
          <SettingsPanel />
        ) : (
          <MissionPanel />
        )
      }
    />
  );
}
