import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { useSettingsStore } from "../../stores/settingsStore";
import { Badge, Button, Input } from "../../components/ui/primitives";
import { ProbeReport } from "./ProbeReport";

export function SettingsPanel() {
  const { providers, activeId, probe, probing } = useSettingsStore();
  const { setActive, test, removeProvider, setKey } = useSettingsStore();
  const [editingKeyFor, setEditingKeyFor] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        {strings.settings.title}
      </h2>

      {providers.map((p) => (
        <div
          key={p.id}
          className={`space-y-3 rounded-lg border p-3 ${
            p.id === activeId
              ? "border-sky-700 bg-sky-950/30"
              : "border-slate-800 bg-slate-900/40"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <button
              onClick={() => setActive(p.id)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate font-medium text-slate-100">{p.name}</div>
              <div className="truncate font-mono text-xs text-slate-400">{p.model}</div>
              {p.baseUrl ? (
                <div className="truncate text-xs text-slate-500">{p.baseUrl}</div>
              ) : null}
            </button>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              {/* hasKey, never the key. There is no endpoint that returns one. */}
              <Badge tone={p.hasKey ? "good" : "bad"}>
                {p.hasKey ? strings.settings.keyPresent : strings.settings.keyMissing}
              </Badge>
              <Badge tone={p.verifiedAt ? "good" : "warn"}>
                {p.verifiedAt
                  ? `${strings.settings.verifiedAt} ${new Date(p.verifiedAt).toLocaleString()}`
                  : strings.settings.neverVerified}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => test(p.id)}
              disabled={probing === p.id || !p.hasKey}
            >
              {probing === p.id ? strings.probe.running : strings.probe.rerun}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditingKeyFor(editingKeyFor === p.id ? null : p.id);
                setKeyDraft("");
              }}
            >
              {strings.settings.setKey}
            </Button>
            <Button variant="ghost" onClick={() => removeProvider(p.id)}>
              {strings.settings.remove}
            </Button>
          </div>

          {editingKeyFor === p.id ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await setKey(p.id, keyDraft);
                setKeyDraft("");
                setEditingKeyFor(null);
              }}
              className="flex gap-2"
            >
              <Input
                type="password"
                autoComplete="off"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder={strings.onboarding.keyPlaceholder}
              />
              <Button type="submit">Save</Button>
            </form>
          ) : null}

          {probe[p.id] ? <ProbeReport result={probe[p.id]!} /> : null}
        </div>
      ))}
    </div>
  );
}
