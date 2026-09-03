/**
 * Add a model endpoint (§3.2).
 *
 * It used to be five text fields, and the one that went wrong was **Model**: a
 * bare string with no feedback until a mission failed on it, whose correct
 * spelling exists in exactly one place — the endpoint. So the form asks the
 * endpoint. `POST /providers/models` builds a throwaway client, calls its
 * `/models`, and the answer becomes a list you pick from.
 *
 * Three things follow from that, and each one is the point rather than a
 * detail:
 *
 * **The list is never shipped.** No dropdown of model names lives in this app.
 * Names go stale in silence — CLAUDE.md already records two model ids this
 * project could not be sure of — and a stale list looks exactly like a fresh
 * one. What ships is a base URL per preset, which the button then proves.
 *
 * **A preset is a guess you confirm.** "Ollama, port 11434" is that project's
 * default, not a fact about this machine, so every field stays editable and
 * pressing Fetch is what settles it.
 *
 * **The text field stays.** An endpoint that does not implement `/models` is a
 * normal thing to meet, and it must not make the form unusable — so the failure
 * shows the endpoint's own words and you type the id, exactly as before.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { Select } from "../../components/ui/Select";
import { useSettingsStore } from "../../stores/settingsStore";
import { api } from "../../transport/rest";
import { Button, Field } from "../../components/ui/primitives";

const FIELD = cn(
  "w-full rounded-[9px] border border-line bg-solid px-3 py-2",
  "text-sm text-text placeholder:text-faint",
);

export function ModelForm({ onDone }: { onDone: () => void }) {
  const createProvider = useSettingsStore((s) => s.createProvider);
  const test = useSettingsStore((s) => s.test);
  const presets = useSettingsStore((s) => s.modelPresets);

  const [presetId, setPresetId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** What the endpoint said it can run. Null until asked — which is not the
   *  same as an empty list, and the two read differently below. */
  const [models, setModels] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const preset = presets.find((p) => p.id === presetId) ?? presets[0] ?? null;

  useEffect(() => {
    // Picking a preset fills the fields it knows and forgets any list fetched
    // for the endpoint before it — those models belonged to a different server.
    if (!preset) return;
    setBaseUrl(preset.baseUrl ?? "");
    setName((current) => (current ? current : preset.name));
    setModels(null);
    setModelsError(null);
  }, [preset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!preset) return null;
  const kind = preset.kind;
  const needsBaseUrl = kind !== "anthropic";

  const fetchModels = async () => {
    setFetching(true);
    setModelsError(null);
    try {
      const answer = await api.endpointModels({
        kind,
        base_url: needsBaseUrl ? baseUrl.trim() || null : null,
        key: key.trim() || null,
      });
      setModels(answer.models);
      // The endpoint's own words, not "could not list models": "connection
      // refused" and "invalid api key" need completely different fixes.
      setModelsError(answer.error);
    } catch (err) {
      setModels([]);
      setModelsError((err as Error).message);
    } finally {
      setFetching(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createProvider({
        name: name.trim() || preset.name,
        kind,
        model: model.trim(),
        // Anthropic's SDK carries its own base URL; sending an empty string
        // would overwrite it with nothing.
        base_url: needsBaseUrl ? baseUrl.trim() : null,
        // Empty means none, which a server on this machine is entitled to
        // want. The endpoint decides whether that works, not this form.
        key: key.trim(),
      });
      // Tested now rather than three minutes into a mission (§3.1).
      await test(created.id);
      setKey("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-[9px] border border-line bg-solid/40 p-4">
      <Field label={strings.settings.presetLabel}>
        <Select
          value={preset.id}
          onChange={setPresetId}
          options={presets.map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>

      {needsBaseUrl ? (
        <Field
          label={strings.settings.baseUrlLabel}
          hint={preset.local ? strings.settings.localHint : undefined}
        >
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className={FIELD}
          />
        </Field>
      ) : null}

      <Field
        label={
          preset.needsKey ? strings.settings.keyLabel : strings.settings.keyOptionalLabel
        }
        hint={preset.needsKey ? strings.settings.keyHint : strings.settings.keyLocalHint}
      >
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className={FIELD}
        />
      </Field>

      <Field label={strings.settings.modelLabel} hint={strings.settings.modelHint}>
        <div className="space-y-2">
          {/* A list only once there is one. Before that the field is what it
              always was, so nothing is worse than before if the ask fails. */}
          {models && models.length > 0 ? (
            <Select
              value={model}
              onChange={setModel}
              placeholder={strings.settings.modelPick}
              options={models.map((m) => ({ value: m, label: m }))}
            />
          ) : (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={strings.settings.modelPlaceholder}
              className={FIELD}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={fetching || (needsBaseUrl && !baseUrl.trim())}
              className={cn(
                "min-h-[24px] rounded-card border border-line px-2.5 py-1 text-xs",
                "text-muted transition-colors hover:bg-solid hover:text-text",
                "disabled:opacity-40",
              )}
            >
              {fetching ? strings.settings.fetchingModels : strings.settings.fetchModels}
            </button>
            {models && models.length > 0 ? (
              <span className="text-[11px] text-faint">
                {strings.settings.modelsFound(models.length)}
              </span>
            ) : null}
            {models && models.length === 0 && !modelsError ? (
              // Answered, and had nothing to offer. Different from not asked,
              // and different from failing.
              <span className="text-[11px] text-faint">
                {strings.settings.modelsNone}
              </span>
            ) : null}
          </div>

          {modelsError ? (
            <p className="text-[11px] text-wait">
              {strings.settings.modelsFailed} {modelsError}
            </p>
          ) : null}
        </div>
      </Field>

      <Field label={strings.settings.nameLabel} hint={strings.settings.nameHint}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={preset.name}
          className={FIELD}
        />
      </Field>

      {error ? <p className="text-xs text-stop">{error}</p> : null}

      <div className="flex gap-2">
        <Button disabled={busy || !model.trim()} onClick={() => void submit()}>
          {busy ? strings.settings.savingModel : strings.settings.saveModel}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {strings.settings.cancel}
        </Button>
      </div>
    </div>
  );
}
