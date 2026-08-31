/**
 * Create an agent from a short prompt (PROJECT_BRIEF.md §11).
 *
 * Three steps on purpose: describe → review → save. The middle one is not
 * optional. §11 requires the generated profile be shown for editing and never
 * written automatically, so "Generate" fills the form and nothing else — the
 * only thing that writes to the roster is the user pressing Save.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { api, type AgentInput, type GenerateResult } from "../../transport/rest";
import { useAgentStore } from "../../stores/agentStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Badge, Button, Field, Input } from "../../components/ui/primitives";
import { AvatarPicker } from "./AvatarPicker";

const EMPTY: AgentInput = {
  name: "",
  title: "",
  role: "",
  backstory: "",
  personality_traits: [],
  system_prompt: "",
  tools: [],
};

export function AgentCreator({ onDone }: { onDone: () => void }) {
  const assets = useAgentStore((s) => s.assets);
  const createAgent = useAgentStore((s) => s.create);
  const providers = useSettingsStore((s) => s.providers);
  const active = useSettingsStore((s) => s.active());

  const [role, setRole] = useState("");
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<AgentInput>(EMPTY);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The provider is the user's choice, not the model's: the model has no idea
  // which endpoints this machine has configured (see schemas.py).
  const [providerId, setProviderId] = useState<string>(active?.id ?? "");
  useEffect(() => {
    if (!providerId && active) setProviderId(active.id);
  }, [active, providerId]);

  const usable = providers.filter((p) => p.hasKey);
  const chosen = providers.find((p) => p.id === providerId) ?? null;
  const ignoresSampling = chosen?.capabilities?.sampling_params === false;

  async function generate() {
    if (!providerId || !role.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.generateAgent({
        provider_id: providerId,
        role: role.trim(),
        brief: brief.trim(),
      });
      setResult(res);
      setDraft({
        name: res.profile.name,
        title: res.profile.title,
        role: res.profile.role,
        backstory: res.profile.backstory,
        personality_traits: res.profile.personality_traits,
        system_prompt: res.profile.system_prompt,
        avatar_config: res.profile.avatar_config,
        tools: [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createAgent({
        ...draft,
        provider_id: providerId || null,
        model: chosen?.model ?? null,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">
          {strings.creator.title}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{strings.creator.intro}</p>
      </div>

      <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <Field label={strings.creator.providerLabel}>
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          >
            {usable.length === 0 ? <option value="">—</option> : null}
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.model}
              </option>
            ))}
          </select>
        </Field>

        <Field label={strings.creator.roleLabel} hint={strings.creator.roleHint}>
          <Input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder={strings.creator.rolePlaceholder}
          />
        </Field>

        <Field label={strings.creator.briefLabel}>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={2}
            placeholder={strings.creator.briefPlaceholder}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
        </Field>

        <Button
          type="button"
          onClick={generate}
          disabled={busy || !providerId || !role.trim()}
        >
          {busy ? strings.creator.generating : strings.creator.generate}
        </Button>

        {result && result.recoveredFrom.length > 0 ? (
          // Not hidden: needing three tries is a fact about the chosen model,
          // and §1 says the UI must not present a run as cleaner than it was.
          <div className="rounded-md border border-amber-900/60 bg-amber-950/30 p-2 text-xs text-amber-300">
            <div className="font-medium">
              {strings.creator.corrected(result.attempts)}
            </div>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-400/80">
              {result.recoveredFrom.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>
      ) : null}

      <form onSubmit={save} className="space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            {strings.creator.reviewTitle}
          </h3>
          <Badge tone="warn">{strings.creator.reviewBadge}</Badge>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={strings.creator.nameLabel}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
          </Field>
          <Field label={strings.creator.titleLabel}>
            <Input
              value={draft.title ?? ""}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
        </div>

        <Field label={strings.creator.roleFieldLabel}>
          <Input
            value={draft.role ?? ""}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          />
        </Field>

        <Field label={strings.creator.traitsLabel} hint={strings.creator.traitsHint}>
          <Input
            value={(draft.personality_traits ?? []).join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                personality_traits: e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>

        <Field label={strings.creator.backstoryLabel}>
          <textarea
            value={draft.backstory ?? ""}
            onChange={(e) => setDraft({ ...draft, backstory: e.target.value })}
            rows={3}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          />
        </Field>

        <Field
          label={strings.creator.systemPromptLabel}
          hint={strings.creator.systemPromptHint}
        >
          <textarea
            value={draft.system_prompt ?? ""}
            onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
            rows={5}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100"
          />
        </Field>

        <AvatarPicker
          assets={assets}
          value={draft.avatar_config ?? {}}
          onChange={(avatar_config) => setDraft({ ...draft, avatar_config })}
        />

        {ignoresSampling ? (
          <p className="text-xs text-amber-400">{strings.creator.samplingIgnored}</p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !draft.name.trim()}>
            {strings.creator.save}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {strings.creator.cancel}
          </Button>
        </div>
      </form>
    </div>
  );
}
