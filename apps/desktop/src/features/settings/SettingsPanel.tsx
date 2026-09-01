import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { useSettingsStore } from "../../stores/settingsStore";
import { Badge, Button, Input } from "../../components/ui/primitives";
import { ProbeReport } from "./ProbeReport";

export function SettingsPanel() {
  const { providers, activeId, probe, probing } = useSettingsStore();
  const { setActive, test, removeProvider, setKey, setNativeSearch } = useSettingsStore();
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

          {p.nativeSearchAvailable ? (
            <div className="space-y-1.5 rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
              <label className="flex items-start gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={p.nativeSearch}
                  onChange={(e) => void setNativeSearch(p.id, e.target.checked)}
                  className="mt-0.5 accent-sky-500"
                />
                <span>
                  {strings.settings.nativeSearchLabel}
                  <span className="block text-[11px] text-slate-500">
                    {strings.settings.nativeSearchHint}
                  </span>
                </span>
              </label>
              {p.nativeSearch ? (
                // Blunt on purpose. This is the one tool the approval gate
                // cannot stop and redaction never sees, and the timeline can
                // only say that it happened (§16.8).
                <p className="rounded border border-amber-900/60 bg-amber-950/30 p-2 text-[11px] text-amber-300">
                  {strings.settings.nativeSearchWarning}
                </p>
              ) : null}
            </div>
          ) : null}

          {probe[p.id] ? <ProbeReport result={probe[p.id]!} /> : null}
        </div>
      ))}

      <SearchEndpointForm />
    </div>
  );
}

/**
 * Adding a search endpoint (§16.5).
 *
 * Separate from onboarding because it is not a model: nothing runs on it, and
 * an app that has only this still cannot start a mission. Its whole effect is
 * that `web_search` appears in the tool registry — with no key it is absent
 * rather than present and failing (§15 row 32).
 */
function SearchEndpointForm() {
  const engines = useSettingsStore((s) => s.searchEngines);
  const providers = useSettingsStore((s) => s.providers);
  const createProvider = useSettingsStore((s) => s.createProvider);
  const test = useSettingsStore((s) => s.test);
  const [open, setOpen] = useState(false);
  const [engineId, setEngineId] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (engines.length === 0) return null;
  const engine = engines.find((e) => e.id === engineId) ?? engines[0]!;
  const configured = providers.filter((p) => p.kind === "search");

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {configured.length > 0
          ? strings.settings.addAnotherSearch
          : strings.settings.addSearch}
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <p className="text-xs text-slate-400">{strings.settings.searchHint}</p>

      <select
        value={engine.id}
        onChange={(e) => setEngineId(e.target.value)}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
      >
        {engines.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {/* The base URL is shown rather than typed: it is what tells the backend
          which API this is, so it is not something to get wrong by hand. */}
      <code className="block truncate text-[11px] text-slate-500">{engine.baseUrl}</code>

      <Input
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={strings.onboarding.keyPlaceholder}
      />
      {error ? <p className="text-xs text-red-400">{error}</p> : null}

      <div className="flex gap-2">
        <Button
          disabled={busy || !key.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const created = await createProvider({
                name: engine.name,
                kind: "search",
                // No model to choose here; the engine id is what the card shows
                // and what makes two search profiles tellable apart.
                model: engine.id,
                base_url: engine.baseUrl,
                key: key.trim(),
              });
              // Tested straight away: a wrong key found now beats one found
              // three minutes into a mission (§3.1).
              await test(created.id);
              setKey("");
              setOpen(false);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? strings.settings.savingSearch : strings.settings.saveSearch}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {strings.teams.close}
        </Button>
      </div>
    </div>
  );
}
