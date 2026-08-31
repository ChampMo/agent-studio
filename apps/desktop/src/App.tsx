import { useEffect, useState } from "react";
import { strings } from "./lib/constants/strings.en";
import { useSettingsStore } from "./stores/settingsStore";
import { OnboardingScreen } from "./features/settings/OnboardingScreen";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { ChatPanel } from "./features/chat/ChatPanel";
import { RosterPanel } from "./features/roster/RosterPanel";
import { TeamsPanel } from "./features/teams/TeamsPanel";
import { MissionPanel } from "./features/mission/MissionPanel";
import { HistoryPanel } from "./features/history/HistoryPanel";
import { ApprovalModal } from "./features/approval/ApprovalModal";
import { TimelinePanel } from "./features/timeline/TimelinePanel";
import { useApprovalStore } from "./stores/approvalStore";
import { cn } from "./lib/cn";

type Tab = "chat" | "roster" | "teams" | "mission" | "history";

export function App() {
  const ready = useSettingsStore((s) => s.ready);
  const loading = useSettingsStore((s) => s.loading);
  const needsOnboarding = useSettingsStore((s) => s.needsOnboarding());
  const waitForBackend = useSettingsStore((s) => s.waitForBackend);
  const pending = useApprovalStore((s) => s.pending);
  const deferred = useApprovalStore((s) => s.deferred);
  const resumeApprovals = useApprovalStore((s) => s.resume);
  const [tab, setTab] = useState<Tab>("chat");

  useEffect(() => {
    void waitForBackend();
  }, [waitForBackend]);

  if (!ready) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-slate-300">{strings.app.waitingForBackend}</p>
        <p className="text-xs text-slate-500">{strings.app.waitingHint}</p>
      </div>
    );
  }

  // No key anywhere means nothing else in the app can work, so onboarding is a
  // gate rather than a suggestion (§3.2).
  if (!loading && needsOnboarding) return <OnboardingScreen />;

  return (
    <div className="grid h-screen grid-cols-[minmax(0,1fr)_360px] grid-rows-1">
      {/* Above every tab: the question can belong to a mission the user is not
          looking at, or to one from a previous session (§12 M6). */}
      <ApprovalModal />

      <main className="flex min-w-0 flex-col border-r border-slate-800">
        <nav className="flex items-center gap-1 border-b border-slate-800 px-3 py-2">
          {(["chat", "roster", "teams", "mission", "history"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === key
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-400 hover:bg-slate-900 hover:text-slate-200",
              )}
            >
              {strings.nav[key]}
            </button>
          ))}

          {/* A deferred question is still a paused mission. Nothing else on
              screen would say so once the modal is out of the way. */}
          {pending.length > 0 && deferred.length > 0 ? (
            <button
              onClick={resumeApprovals}
              className="ml-auto rounded-md bg-amber-900/60 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900"
            >
              {strings.approval.waiting(pending.length)} · {strings.approval.reopen}
            </button>
          ) : null}
        </nav>
        <div className="min-h-0 flex-1">
          {tab === "chat" ? (
            <ChatPanel />
          ) : tab === "roster" ? (
            <RosterPanel />
          ) : tab === "teams" ? (
            <TeamsPanel />
          ) : tab === "mission" ? (
            <MissionPanel />
          ) : (
            <HistoryPanel />
          )}
        </div>
      </main>

      <aside className="flex min-w-0 flex-col divide-y divide-slate-800 overflow-hidden">
        <div className="min-h-0 flex-1">
          <TimelinePanel />
        </div>
        <div className="max-h-[45%] overflow-y-auto">
          <SettingsPanel />
        </div>
      </aside>
    </div>
  );
}
