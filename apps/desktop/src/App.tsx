import { useEffect } from "react";
import { strings } from "./lib/constants/strings.en";
import { useSettingsStore } from "./stores/settingsStore";
import { OnboardingScreen } from "./features/settings/OnboardingScreen";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { ChatPanel } from "./features/chat/ChatPanel";
import { TimelinePanel } from "./features/timeline/TimelinePanel";

export function App() {
  const ready = useSettingsStore((s) => s.ready);
  const loading = useSettingsStore((s) => s.loading);
  const needsOnboarding = useSettingsStore((s) => s.needsOnboarding());
  const waitForBackend = useSettingsStore((s) => s.waitForBackend);

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
      <main className="min-w-0 border-r border-slate-800">
        <ChatPanel />
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
