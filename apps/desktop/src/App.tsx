import { useEffect, useState } from "react";
import { strings } from "./lib/constants/strings.en";
import { useSettingsStore } from "./stores/settingsStore";
import { OnboardingScreen } from "./features/settings/OnboardingScreen";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { ChatPanel } from "./features/chat/ChatPanel";
import { RosterPanel } from "./features/roster/RosterPanel";
import { TeamsPanel } from "./features/teams/TeamsPanel";
import { MissionPanel } from "./features/mission/MissionPanel";
import { TimelinePanel } from "./features/timeline/TimelinePanel";
import { cn } from "./lib/cn";

type Tab = "chat" | "roster" | "teams" | "mission";

export function App() {
  const ready = useSettingsStore((s) => s.ready);
  const loading = useSettingsStore((s) => s.loading);
  const needsOnboarding = useSettingsStore((s) => s.needsOnboarding());
  const waitForBackend = useSettingsStore((s) => s.waitForBackend);
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
      <main className="flex min-w-0 flex-col border-r border-slate-800">
        <nav className="flex gap-1 border-b border-slate-800 px-3 py-2">
          {(["chat", "roster", "teams", "mission"] as const).map((key) => (
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
        </nav>
        <div className="min-h-0 flex-1">
          {tab === "chat" ? (
            <ChatPanel />
          ) : tab === "roster" ? (
            <RosterPanel />
          ) : tab === "teams" ? (
            <TeamsPanel />
          ) : (
            <MissionPanel />
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
