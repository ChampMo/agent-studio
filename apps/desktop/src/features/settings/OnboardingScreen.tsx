/**
 * First run: no key, nothing else is usable (PROJECT_BRIEF.md §3.2).
 *
 * The key is typed once and posted straight to the backend, which puts it in
 * the OS keychain. It is never written to component state that outlives the
 * submit, never to localStorage, and there is no endpoint to read it back.
 */
import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button, Field, Input } from "../../components/ui/primitives";
import { ProbeReport } from "./ProbeReport";

export function OnboardingScreen() {
  const createProvider = useSettingsStore((s) => s.createProvider);
  const test = useSettingsStore((s) => s.test);
  const probe = useSettingsStore((s) => s.probe);

  const [kind, setKind] = useState<"openai_compatible" | "anthropic">(
    "openai_compatible",
  );
  const [name, setName] = useState("DeepSeek");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [model, setModel] = useState("deepseek-v4-flash");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const result = createdId ? probe[createdId] : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createProvider({
        name,
        kind,
        model,
        base_url: kind === "anthropic" ? null : baseUrl,
        key,
      });
      setCreatedId(created.id);
      // Clear it the moment it has been handed over. Nothing keeps a copy.
      setKey("");
      await test(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
      <h1 className="text-xl font-semibold text-text">
        {strings.onboarding.title}
      </h1>
      <p className="mt-2 text-sm text-muted">{strings.onboarding.intro}</p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label={strings.onboarding.kindLabel}>
          <select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as typeof kind;
              setKind(next);
              if (next === "anthropic") {
                setName("Anthropic");
                setModel("claude-haiku-4-5");
              }
            }}
            className="w-full rounded-md border border-line bg-solid px-3 py-2 text-sm text-text"
          >
            <option value="openai_compatible">
              {strings.onboarding.kindOpenAI}
            </option>
            <option value="anthropic">
              {strings.onboarding.kindAnthropic}
            </option>
          </select>
        </Field>

        <Field label={strings.onboarding.nameLabel}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={strings.onboarding.namePlaceholder}
            required
          />
        </Field>

        {kind === "openai_compatible" ? (
          <Field
            label={strings.onboarding.baseUrlLabel}
            hint={strings.onboarding.baseUrlHint}
          >
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={strings.onboarding.baseUrlPlaceholder}
              required
            />
          </Field>
        ) : null}

        <Field
          label={strings.onboarding.modelLabel}
          hint={strings.onboarding.modelHint}
        >
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={strings.onboarding.modelPlaceholder}
            required
          />
        </Field>

        <Field
          label={strings.onboarding.keyLabel}
          hint={strings.onboarding.keyHint}
        >
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={strings.onboarding.keyPlaceholder}
            autoComplete="off"
            required={!createdId}
          />
        </Field>

        {error ? (
          <p className="rounded-md bg-stop/10 px-3 py-2 text-sm text-stop">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? strings.onboarding.saving : strings.onboarding.save}
        </Button>
      </form>

      {result ? (
        <div className="mt-5">
          <ProbeReport result={result} />
        </div>
      ) : null}
    </div>
  );
}
